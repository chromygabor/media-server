// Hamis médiaszerver az appok tesztjeihez (csomagterv WP35, P7): egy `node:http` szerver a valódi (nginx + njs)
// helyett, a SPEC szabályaival. Az ellenőrzés a `verifySignedPath` (a SPEC 4. sorrendje és okai; a közös vektorok
// tartják az njs-sel egyben, a `fake-server.spec.ts` konformanciatesztje a HTTP-státuszokat is), a fájl a
// `<root>/<dir>/<assetKey>` (SPEC 6.; `dir` = `.` → `<root>/<assetKey>`), a válasz a SPEC 4–5. szerint: `Range` →
// `206` / `416`, `HEAD`, `ETag` / `Last-Modified` / `304`, `If-Range`, CORS az `origins`-ből, CORP, `Cache-Control`,
// `/healthz`, `OPTIONS`, `405`, hibás `apps.json` mellett minden kérésre `403` (`apps-invalid`).
//
// Nincs benne: a korlátok (`429`, `503`, `limit_rate`) és a napló; ezek a valódi szerver docker-tesztjében vannak.
// A tesztből vezérelhető: `override` (más státusz, késleltetés, más törzs, fejléc, rövidített Range-válasz; függvényként
// kérésenként és aszinkron is, pl. egy kérés visszatartására), `now` (az óra), `routes` (saját végpontok, pl. egy
// másik folyamatból hívható vezérlő), és a `requests` napló.

import { createReadStream, statSync, type Stats } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { validateAppsFile, type AppsFile } from '../apps-config.js';
import { isSafeSegment } from '../path.js';
import { appLookupFrom, verifySignedPath, type VerifyResult } from '../token.js';

/** A `verifySignedPath`-on kívüli elutasítás (SPEC 4.): hibás `apps.json`, illetve belső kivétel. */
export type FakeMediaFailure = { ok: false; status: 403; reason: 'apps-invalid' | 'internal-error' };

/** Egy kérés a naplóban (`FakeMediaServer.requests`), érkezési sorrendben; a `/healthz` és a `routes` nincs benne. */
export interface FakeMediaRequest {
  method: string;
  /** A nyers kérés-URI (tokennel, query-vel). */
  uri: string;
  /** Az útvonal token és query nélkül (mint a valódi szerver naplójában). */
  path: string;
  /** Az URI `expires` paramétere, ha van. */
  expires: number | null;
  /** A `Range` fejléc, ha van. */
  range: string | null;
  /** Az `Origin` fejléc, ha van. */
  origin: string | null;
  /**
   * Az ellenőrzés eredménye. Érkezéskor számolva, majd az `override` (késleltetés, visszatartás) után a pillanatnyi
   * órával újraszámolva: a válasz ez utóbbin múlik. `GET`/`HEAD`-en kívül is kitöltött, de ott nem számít.
   */
  verify: VerifyResult | FakeMediaFailure;
  /** A válasz státusza; `0`, amíg nincs válasz. */
  status: number;
}

/** A tesztből beállítható eltérés a szabályos választól (a `GET`/`HEAD` médiakérésekre). */
export interface FakeMediaOverride {
  /** Ennyit vár az ellenőrzés előtt (pl. időtúllépés-teszt). */
  delayMs?: number;
  /** Ezt a státuszt adja üres törzzsel, a tokentől és a fájltól függetlenül (a `headers`-szel együtt). */
  status?: number;
  /** A fájl helyett ezt a törzset adja (érvényes tokenre; a `Range` erre is vonatkozik). */
  body?: Uint8Array;
  /** További vagy felülírt fejlécek a sikeres (`200`/`206`) válaszon, pl. `content-encoding`, `content-type`. */
  headers?: Record<string, string>;
  /**
   * Lassú hálózat: az ennél a bájtnál korábban kezdődő `Range`-kérés válasza legfeljebb az előtte lévő bájtig tart
   * (rövid `206`; a böngésző a többit később kéri).
   */
  truncateAt?: number;
}

/**
 * Kérésenkénti felülírás: a naplóbejegyzéssel hívva, az ellenőrzés előtt. Aszinkron is lehet (a kérés addig vár, és a
 * token a várakozás után, a pillanatnyi órával ellenőrződik); `null`/`undefined`: nincs eltérés.
 */
export type FakeMediaOverrideFn = (
  request: FakeMediaRequest,
) => FakeMediaOverride | null | undefined | Promise<FakeMediaOverride | null | undefined>;

/** Saját végpont (`routes`): pontos útvonal (query nélkül) → kezelő; a médiakérések elé kerül. */
export type FakeMediaRoute = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface FakeMediaServerOptions {
  /** Az `apps.json` tartalma; induláskor a `validateAppsFile` ellenőrzi (hibásnál minden médiakérés `403`). */
  apps: AppsFile;
  /** A médiagyökér (a valódi szerver `/srv/media`-ja): a fájl `<root>/<dir>/<assetKey>`. */
  root: string;
  /** Az óra, Unix-ezredmásodperc (alapból `Date.now`), mint a `createUrlSigner`-nél; kérésenként olvasva. */
  now?: () => number;
  /** Alapból `0` (szabad port). */
  port?: number;
  /** Alapból `127.0.0.1`. */
  host?: string;
  routes?: Readonly<Record<string, FakeMediaRoute>>;
}

export interface FakeMediaServer {
  /** `http://<host>:<port>`, záró `/` nélkül (a `createUrlSigner` `baseUrl`-je). */
  readonly url: string;
  /** A kérések naplója; a teszt ürítheti (`requests.length = 0`). */
  requests: FakeMediaRequest[];
  /** A következő kérésekre érvényes eltérés; `null`: szabályos válasz. */
  override: FakeMediaOverride | FakeMediaOverrideFn | null;
  /** Leállítja a szervert (a nyitott kapcsolatokat is bontja); többször hívható. Önálló függvény (`this` nélkül). */
  close: () => Promise<void>;
}

const SEGMENT_START = '/bcdn_token=';
const CACHE_BROWSER = 'private, max-age=3600';
const CACHE_NONE = 'no-store';
const CACHEABLE_STATUS = new Set([200, 206, 304]);
const ERROR_BODY: Readonly<Record<number, string>> = { 403: 'forbidden\n', 404: 'not found\n', 410: 'expired\n' };

/** A nyers URI token nélküli útvonala (mint az njs `plainPath`-ja): a query és a `/bcdn_token=…` szegmens levágva. */
function plainPath(rawUri: string): string {
  const q = rawUri.indexOf('?');
  let uri = q === -1 ? rawUri : rawUri.slice(0, q);
  if (uri.startsWith(SEGMENT_START)) {
    const slash = uri.indexOf('/', 1);
    uri = slash === -1 ? '' : uri.slice(slash);
  }
  return uri;
}

function expiresOf(rawUri: string): number | null {
  const m = /^\/bcdn_token=[^/?]*&expires=(\d+)(?:[/?]|$)/.exec(rawUri);
  return m ? Number(m[1]) : null;
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n` (egy tartomány); `null`: nincs vagy nem értelmezhető (→ teljes válasz). */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A hamis médiaszerver indítása (`await`-tel: a visszatéréskor már fogad kéréseket). */
export async function startFakeMediaServer(options: FakeMediaServerOptions): Promise<FakeMediaServer> {
  const { root, routes = {} } = options;
  const now = options.now ?? Date.now;
  const host = options.host ?? '127.0.0.1';
  // A valódi szerver is induláskor (konfigtöltéskor) dönt; a tesztben utólag módosított `apps` nem számít.
  const appsOk = validateAppsFile(options.apps).ok;
  const apps: AppsFile = appsOk ? structuredClone(options.apps) : {};
  const lookup = appLookupFrom(apps);

  const verify = (uri: string): VerifyResult | FakeMediaFailure => {
    if (!appsOk) return { ok: false, status: 403, reason: 'apps-invalid' };
    try {
      return verifySignedPath(uri, lookup, Math.floor(now() / 1000));
    } catch {
      return { ok: false, status: 403, reason: 'internal-error' };
    }
  };

  /** Az útvonal első szegmenséből az app beállítása, hitelesítés nélkül (CORS, CORP; SPEC 5.). */
  const appOf = (path: string) => {
    const app = path.split('/')[1] ?? '';
    return appsOk && isSafeSegment(app) && Object.hasOwn(apps, app) ? apps[app]! : null;
  };

  /** A fő location fejlécei (az njs `headers` szűrője; SPEC 5.): a 200/206/304/416, az `OPTIONS` és a 405 kapja. */
  const mainHeaders = (req: IncomingMessage, path: string, status: number, browser: boolean) => {
    const cfg = appOf(path);
    const h: Record<string, string> = {
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
      'cross-origin-resource-policy': cfg?.corp ?? 'same-site',
      'cache-control': CACHEABLE_STATUS.has(status) && browser ? CACHE_BROWSER : CACHE_NONE,
      vary: 'Origin',
    };
    const origin = req.headers.origin;
    if (typeof origin === 'string' && cfg?.origins?.includes(origin)) {
      h['access-control-allow-origin'] = origin;
      h['access-control-expose-headers'] = 'Content-Length, Content-Range, Accept-Ranges';
      h['access-control-allow-methods'] = 'GET, HEAD, OPTIONS';
      h['access-control-allow-headers'] = 'Range, If-Range';
      h['access-control-max-age'] = '600';
    }
    return h;
  };

  const handleMedia = async (req: IncomingMessage, res: ServerResponse, server: FakeMediaServer) => {
    const uri = req.url ?? '/';
    const path = plainPath(uri);
    const method = req.method ?? 'GET';
    const entry: FakeMediaRequest = {
      method,
      uri,
      path,
      expires: expiresOf(uri),
      range: req.headers.range ?? null,
      origin: typeof req.headers.origin === 'string' ? req.headers.origin : null,
      verify: verify(uri),
      status: 0,
    };
    server.requests.push(entry);
    const send = (status: number, headers: Record<string, string | number>, body?: string) => {
      entry.status = status;
      res.writeHead(status, headers);
      res.end(method === 'HEAD' ? undefined : body);
    };
    /** A 403/404/410 a valódi szerver named location-jeiből: rövid szöveg, nosniff, no-store (CORS nélkül). */
    const fail = (status: number) =>
      send(status, { 'content-type': 'text/plain', 'x-content-type-options': 'nosniff', 'cache-control': CACHE_NONE }, ERROR_BODY[status] ?? '');

    if (method === 'OPTIONS') return send(204, mainHeaders(req, path, 204, false));
    if (method !== 'GET' && method !== 'HEAD') return send(405, { ...mainHeaders(req, path, 405, false), 'content-type': 'text/plain' }, 'method not allowed\n');

    const current = server.override;
    const o = (typeof current === 'function' ? await current(entry) : current) ?? {};
    if (o.delayMs !== undefined) await sleep(o.delayMs);
    const verdict = verify(uri);
    entry.verify = verdict;
    if (o.status !== undefined) {
      entry.status = o.status;
      res.writeHead(o.status, { 'cache-control': CACHE_NONE, ...o.headers });
      res.end();
      return;
    }
    if (!verdict.ok) return fail(verdict.status);

    // A fájl (a valódi szerver `try_files`-a: csak szabályos fájl, könyvtár nem) vagy az `override.body`.
    const dir = apps[verdict.app]!.dir;
    const file = dir === '.' ? join(root, verdict.assetKey) : join(root, dir, verdict.assetKey);
    let stat: Stats | null = null;
    if (o.body === undefined) {
      try {
        stat = statSync(file);
      } catch {
        stat = null;
      }
      if (stat === null || !stat.isFile()) return fail(404);
    }
    const size = o.body?.byteLength ?? stat!.size;
    const browser = verdict.kind === 'browser';
    const validators: Record<string, string> = {};
    if (stat !== null) {
      // Az nginx alakja: `"<mtime hex>-<méret hex>"`, illetve a módosítás ideje másodpercre.
      validators.etag = `"${Math.floor(stat.mtimeMs / 1000).toString(16)}-${size.toString(16)}"`;
      validators['last-modified'] = new Date(Math.floor(stat.mtimeMs / 1000) * 1000).toUTCString();
    }
    const base = (status: number): Record<string, string | number> => ({
      ...mainHeaders(req, path, status, browser),
      'content-type': verdict.contentType,
      'accept-ranges': 'bytes',
      ...validators,
    });
    const extra = Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

    // Feltételes kérés (az nginx szerint: `If-None-Match` az ETag-re, különben `If-Modified-Since` pontos egyezéssel).
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    const notModified =
      validators.etag !== undefined &&
      (inm !== undefined
        ? inm.split(',').some((t) => t.trim() === '*' || t.trim().replace(/^W\//, '') === validators.etag)
        : ims !== undefined && ims === validators['last-modified']);
    if (notModified) {
      entry.status = 304;
      res.writeHead(304, base(304));
      res.end();
      return;
    }

    // `If-Range`: ha nem az aktuális ETag / Last-Modified, a `Range` nem számít (teljes válasz).
    const ifRange = req.headers['if-range'];
    const rangeHeader =
      ifRange === undefined || (validators.etag !== undefined && (ifRange === validators.etag || ifRange === validators['last-modified']))
        ? req.headers.range
        : undefined;
    const range = parseRange(rangeHeader, size);
    const body = (start: number, end: number) => {
      if (method === 'HEAD' || end < start) res.end();
      else if (o.body !== undefined) res.end(o.body.subarray(start, end + 1));
      else createReadStream(file, { start, end }).pipe(res);
    };

    if (range === 'unsatisfiable') {
      const headers = base(416);
      delete headers.etag;
      delete headers['last-modified'];
      return send(416, { ...headers, 'content-type': 'text/plain', 'content-range': `bytes */${size}` }, 'range not satisfiable\n');
    }
    if (range === null) {
      entry.status = 200;
      res.writeHead(200, { ...base(200), 'content-length': size, ...extra });
      body(0, size - 1);
      return;
    }
    const end = o.truncateAt !== undefined && range.start < o.truncateAt ? Math.min(range.end, o.truncateAt - 1) : range.end;
    entry.status = 206;
    res.writeHead(206, { ...base(206), 'content-length': end - range.start + 1, 'content-range': `bytes ${range.start}-${end}/${size}`, ...extra });
    body(range.start, end);
  };

  // A kezelő csak a `listen` után futhat, addigra a `state` kész.
  let state!: FakeMediaServer;
  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0]!;
    const route = Object.hasOwn(routes, pathname) ? routes[pathname] : undefined;
    const run = async () => {
      if (route !== undefined) return route(req, res);
      // A valódi szerver `location = /healthz`-e: token nélkül, bármely metódusra, napló nélkül.
      if (pathname === '/healthz') {
        res.writeHead(204).end();
        return;
      }
      return handleMedia(req, res, state);
    };
    run().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | null = null;
  state = {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    requests: [],
    override: null,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      return closing;
    },
  };
  return state;
}
