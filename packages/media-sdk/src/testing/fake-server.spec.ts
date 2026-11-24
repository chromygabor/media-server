// A hamis médiaszerver (csomagterv WP35). Konformancia: a `test-vectors.json` minden `verify` vektora ugyanazt a
// HTTP-státuszt adja, mint a valódi szerveren (a médiaszerver docker-tesztje a vektorokat a konténer njs-én futtatja,
// `server/test/docker/njs-vectors.js`; a `200`-as vektor a fájl létezésétől függően `200` vagy `404`, mint az
// nginx `try_files`-a). A `createUrlSigner` linkjei a lejáratig `200`, utána `410` (a signer property-tesztjeinek
// bemeneteivel). Utána a SPEC 4–5. válaszai és a tesztvezérlés (`override`, `now`, `routes`, `requests`).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKey, isValidAppName, type AppsFile } from '../apps-config.js';
import { isValidKeyId } from '../keys.js';
import { createUrlSigner } from '../signer.js';
import { buildSignedPath, type AppKeys } from '../token.js';
import { startFakeMediaServer, type FakeMediaServer } from './fake-server.js';
import { testAppsFile, testKeys } from './test-keys.js';

interface VerifyVector {
  name: string;
  requestUri: string;
  keys: Record<string, AppKeys>;
  now: number;
  expected: { status: number; reason?: string; app?: string };
}
const vectors = JSON.parse(readFileSync(new URL('../../test-vectors.json', import.meta.url), 'utf8')) as { verify: VerifyVector[] };

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** Nyers kérés: az URI változatlanul megy ki (a `fetch` normalizálná a `..`-ot és a `//`-t). */
function get(base: string, uri: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, path: uri, method: init.method ?? 'GET', headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const tmp = mkdtempSync(join(tmpdir(), 'media-sdk-fake-'));
let seq = 0;
/** Friss médiagyökér a megadott fájlokkal (`<útvonal a gyökér alatt>` → tartalom). */
function rootWith(files: Record<string, string | Buffer> = {}): string {
  const root = join(tmp, `root-${++seq}`);
  mkdirSync(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('konformancia: a test-vectors.json verify vektorai HTTP-n', () => {
  it.each(vectors.verify.map((v) => [v.name, v] as const))('%s', async (_name, v) => {
    // A vektor kulcsai `dir`-rel (az app saját könyvtára); a fájl ott van, ahová a valódi szerver nézne.
    const apps: AppsFile = Object.fromEntries(Object.entries(v.keys).map(([app, k]) => [app, { dir: `d-${app}`, ...k }]));
    const plain = v.requestUri.split('?')[0]!.replace(/^\/bcdn_token=[^/]*/, '');
    const app = plain.split('/')[1]!;
    const withFile = rootWith(v.expected.status === 200 ? { [`d-${app}/${plain.split('/').slice(2).join('/')}`]: 'media' } : {});
    const fake = await startFakeMediaServer({ apps, root: withFile, now: () => v.now * 1000 });
    const empty = await startFakeMediaServer({ apps, root: rootWith(), now: () => v.now * 1000 });
    try {
      const res = await get(fake.url, v.requestUri);
      expect(res.status).toBe(v.expected.status);
      expect(fake.requests).toEqual([expect.objectContaining({ uri: v.requestUri, status: v.expected.status })]);
      const verify = fake.requests[0]!.verify;
      if (v.expected.status === 200) {
        expect(verify).toMatchObject({ ok: true, app: v.expected.app });
        expect(res.body.toString()).toBe('media');
        // Ugyanaz a link, a fájl nélkül: 404 (SPEC 4., 9. lépés).
        expect((await get(empty.url, v.requestUri)).status).toBe(404);
      } else {
        expect(verify).toEqual({ ok: false, status: v.expected.status, reason: v.expected.reason });
      }
    } finally {
      await fake.close();
      await empty.close();
    }
  });
});

describe('createUrlSigner linkjei a hamis szerveren', () => {
  it('testKeys: a signDirectory és a signContentFile linkje a lejáratig 200, utána 410', async () => {
    let nowMs = 1_800_000_000_000;
    const root = rootWith({ 'c/l1/a.mp4': 'video', 'c/l1/sub/b.jpg': 'poster', '_content/2026.11.24-1.json.gz': 'gz' });
    const fake = await startFakeMediaServer({ apps: testKeys.apps, root, now: () => nowMs });
    try {
      const signer = createUrlSigner({ ...testKeys, baseUrl: fake.url, maxTtlSeconds: 600, now: () => nowMs });
      const out = signer.signDirectory({ scopeDir: 'c/l1/', userId: 'u1', tokenExp: null, assets: [{ assetKey: 'c/l1/a.mp4', sha256: 'ab'.repeat(32) }, { assetKey: 'c/l1/sub/b.jpg' }] });
      const content = signer.signContentFile('2026.11.24-1');
      if (!('url' in content)) throw new Error('várt URL');
      const urls = [...out.results.map((r) => ('url' in r ? r.url : '')), content.url].map((u) => u.slice(fake.url.length));
      const statuses = async () => Promise.all(urls.map(async (u) => (await get(fake.url, u)).status));

      expect(await statuses()).toEqual([200, 200, 200]);
      nowMs = content.expiresAt.getTime();
      expect(await statuses()).toEqual([200, 200, 200]);
      nowMs += 1000;
      expect(await statuses()).toEqual([200, 200, 410]);
      nowMs = out.expiresAt.getTime() + 1000;
      expect(await statuses()).toEqual([410, 410, 410]);
    } finally {
      await fake.close();
    }
  });

  it('property: véletlen app, kid, kulcs, hatókör és fájl → 200 a lejáratig, utána 410; a fájl nélkül 404', async () => {
    const SAFE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.';
    const segment = fc
      .array(fc.constantFrom(...SAFE.split('')), { minLength: 1, maxLength: 10 })
      .map((cs) => cs.join(''))
      .filter((s) => !s.startsWith('.') && !s.startsWith('_'));
    const caseArb = fc.record({
      app: segment.filter(isValidAppName),
      kid: segment.filter(isValidKeyId),
      dirs: fc.array(segment, { minLength: 1, maxLength: 3 }),
      sub: fc.array(segment, { maxLength: 2 }),
      base: segment,
      ext: fc.constantFrom('.mp4', '.m4a', '.jpg'),
      userId: segment,
      now: fc.integer({ min: 1, max: 3_000_000_000 }),
      maxTtl: fc.integer({ min: 1, max: 100_000 }),
      dir: fc.constantFrom('.', 'media', 'a/b'),
    });
    await fc.assert(
      fc.asyncProperty(caseArb, async (c) => {
        let nowMs = c.now * 1000;
        const key = generateKey();
        const scopeDir = `${c.dirs.join('/')}/`;
        const assetKey = `${scopeDir}${[...c.sub, c.base + c.ext].join('/')}`;
        const apps: AppsFile = { [c.app]: { dir: c.dir, keys: { [c.kid]: key }, contentKeys: {} } };
        const rel = c.dir === '.' ? assetKey : `${c.dir}/${assetKey}`;
        const fake = await startFakeMediaServer({ apps, root: rootWith({ [rel]: 'x' }), now: () => nowMs });
        const empty = await startFakeMediaServer({ apps, root: rootWith(), now: () => nowMs });
        try {
          const signer = createUrlSigner({ baseUrl: '', app: c.app, kid: c.kid, key, maxTtlSeconds: c.maxTtl, now: () => nowMs });
          const { expiresAt, results } = signer.signDirectory({ scopeDir, userId: c.userId, assets: [{ assetKey }] });
          const r = results[0]!;
          if (!('url' in r)) throw new Error(`várt URL, kapott: ${JSON.stringify(r)}`);
          expect((await get(fake.url, r.url)).status).toBe(200);
          expect((await get(empty.url, r.url)).status).toBe(404);
          nowMs = expiresAt.getTime();
          expect((await get(fake.url, r.url)).status).toBe(200);
          nowMs += 1000;
          expect((await get(fake.url, r.url)).status).toBe(410);
          expect(fake.requests.at(-1)?.verify).toMatchObject({ ok: false, reason: 'expired' });
        } finally {
          await fake.close();
          await empty.close();
        }
      }),
      { numRuns: 40 },
    );
  });
});

// --- A SPEC 4–5. válaszai --------------------------------------------------------------------------------------

const NOW_S = 1_800_000_000;
const sign = (path: string, opts: { content?: boolean; expires?: number } = {}) =>
  buildSignedPath({
    key: opts.content ? testKeys.contentKey : testKeys.key,
    kid: opts.content ? testKeys.contentKid : testKeys.kid,
    tokenPath: opts.content ? path : `${path.slice(0, path.lastIndexOf('/') + 1)}`,
    expires: opts.expires ?? NOW_S + 60,
    ...(opts.content ? {} : { u: 'u1' }),
    path,
  });

describe('válaszok (SPEC 4–5.)', () => {
  const VIDEO = Buffer.from('0123456789abcdefghij'); // 20 bájt
  let root: string;
  let fake: FakeMediaServer;
  const APP = testKeys.app;
  beforeAll(async () => {
    root = rootWith({ 'l/v.mp4': VIDEO, '_content/1.json.gz': 'gz', 'l/dir.mp4/x.mp4': 'x' });
    fake = await startFakeMediaServer({
      apps: testAppsFile({ origins: ['https://app.test'], corp: 'cross-origin' }),
      root,
      now: () => NOW_S * 1000,
    });
  });
  afterAll(() => fake.close());
  beforeEach(() => {
    fake.requests.length = 0;
    fake.override = null;
  });

  const video = () => sign(`/${APP}/l/v.mp4`);

  it('200: a fájl, a SPEC 5. fejléceivel; a böngészős fájl private cache, Content-Encoding nincs', async () => {
    const res = await get(fake.url, `${video()}?v=abc`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(VIDEO);
    expect(res.headers).toMatchObject({
      'content-type': 'video/mp4',
      'content-length': '20',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
      'cross-origin-resource-policy': 'cross-origin',
      'cache-control': 'private, max-age=3600',
      vary: 'Origin',
    });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers.etag).toMatch(/^"[0-9a-f]+-14"$/);
    expect(fake.requests).toEqual([
      expect.objectContaining({ method: 'GET', path: `/${APP}/l/v.mp4`, expires: NOW_S + 60, range: null, status: 200 }),
    ]);
  });

  it('tartalomfájl: application/gzip, no-store', async () => {
    const res = await get(fake.url, sign(`/${APP}/_content/1.json.gz`, { content: true }));
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({ 'content-type': 'application/gzip', 'cache-control': 'no-store' });
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('Range → 206 / 416; HEAD törzs nélkül', async () => {
    const part = await get(fake.url, video(), { headers: { range: 'bytes=2-5' } });
    expect(part.status).toBe(206);
    expect(part.body.toString()).toBe('2345');
    expect(part.headers).toMatchObject({ 'content-range': 'bytes 2-5/20', 'content-length': '4', 'cache-control': 'private, max-age=3600' });
    expect((await get(fake.url, video(), { headers: { range: 'bytes=15-' } })).body.toString()).toBe('fghij');
    expect((await get(fake.url, video(), { headers: { range: 'bytes=-3' } })).body.toString()).toBe('hij');
    const bad = await get(fake.url, video(), { headers: { range: 'bytes=20-' } });
    expect(bad.status).toBe(416);
    expect(bad.headers).toMatchObject({ 'content-range': 'bytes */20', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    expect((await get(fake.url, video(), { headers: { range: 'nem-range' } })).status).toBe(200);
    const head = await get(fake.url, video(), { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe('20');
    expect(head.body).toHaveLength(0);
  });

  it('ETag / Last-Modified: If-None-Match és If-Modified-Since → 304; If-Range eltérő ETag-gel → teljes 200', async () => {
    utimesSync(join(root, 'l/v.mp4'), 1_700_000_000, 1_700_000_000);
    const first = await get(fake.url, video());
    const etag = first.headers.etag as string;
    expect(first.headers['last-modified']).toBe(new Date(1_700_000_000_000).toUTCString());
    const cached = await get(fake.url, video(), { headers: { 'if-none-match': etag } });
    expect(cached.status).toBe(304);
    expect(cached.headers['cache-control']).toBe('private, max-age=3600');
    expect((await get(fake.url, video(), { headers: { 'if-modified-since': first.headers['last-modified'] as string } })).status).toBe(304);
    expect((await get(fake.url, video(), { headers: { range: 'bytes=0-1', 'if-range': etag } })).status).toBe(206);
    expect((await get(fake.url, video(), { headers: { range: 'bytes=0-1', 'if-range': '"más"' } })).status).toBe(200);
  });

  it('hibaválaszok: 403/404/410 rövid szöveggel, nosniff, no-store; a nem létező fájl és a könyvtár 404', async () => {
    const forbidden = await get(fake.url, `/bcdn_token=x/${APP}/l/v.mp4`);
    expect(forbidden).toMatchObject({ status: 403, headers: { 'content-type': 'text/plain', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } });
    expect(forbidden.body.toString()).toBe('forbidden\n');
    expect((await get(fake.url, sign(`/${APP}/l/nincs.mp4`))).body.toString()).toBe('not found\n');
    expect((await get(fake.url, sign(`/${APP}/l/dir.mp4`))).status).toBe(404);
    const gone = await get(fake.url, sign(`/${APP}/l/v.mp4`, { expires: NOW_S - 1 }));
    expect(gone.status).toBe(410);
    expect(gone.body.toString()).toBe('expired\n');
    expect(fake.requests.map((r) => r.verify.ok ? r.status : `${r.status} ${r.verify.reason}`)).toEqual(['403 malformed', 404, 404, '410 expired']);
  });

  it('CORS: csak az app saját originje kapja; OPTIONS 204 token nélkül; más metódus 405; /healthz 204 (napló nélkül)', async () => {
    const allowed = await get(fake.url, video(), { headers: { origin: 'https://app.test' } });
    expect(allowed.headers).toMatchObject({
      'access-control-allow-origin': 'https://app.test',
      'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'Range, If-Range',
      'access-control-max-age': '600',
    });
    const other = await get(fake.url, video(), { headers: { origin: 'https://masik.test' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await get(fake.url, `/${APP}/l/v.mp4`, { method: 'OPTIONS', headers: { origin: 'https://app.test' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://app.test');
    expect((await get(fake.url, video(), { method: 'POST' })).status).toBe(405);
    expect((await get(fake.url, '/healthz')).status).toBe(204);
    expect(fake.requests.map((r) => [r.method, r.status, r.origin])).toEqual([
      ['GET', 200, 'https://app.test'],
      ['GET', 200, 'https://masik.test'],
      ['OPTIONS', 204, 'https://app.test'],
      ['POST', 405, null],
    ]);
  });
});

describe('dir és apps.json', () => {
  it('dir: alkönyvtár és közös dir két appnak; a CORP alapból same-site', async () => {
    const root = rootWith({ 'shared/x/a.jpg': 'shared', 'only/x/a.jpg': 'only' });
    const keys = { keys: { [testKeys.kid]: testKeys.key }, contentKeys: {} };
    const fake = await startFakeMediaServer({
      apps: { one: { dir: 'shared', ...keys }, two: { dir: 'shared', ...keys }, three: { dir: 'only', ...keys } },
      root,
      now: () => NOW_S * 1000,
    });
    try {
      for (const [app, body] of [['one', 'shared'], ['two', 'shared'], ['three', 'only']]) {
        const res = await get(fake.url, sign(`/${app}/x/a.jpg`));
        expect(res).toMatchObject({ status: 200, headers: { 'cross-origin-resource-policy': 'same-site', 'content-type': 'image/jpeg' } });
        expect(res.body.toString()).toBe(body);
      }
    } finally {
      await fake.close();
    }
  });

  it('hibás apps.json → minden médiakérés 403 apps-invalid; a /healthz és az OPTIONS marad', async () => {
    const root = rootWith({ 'l/v.mp4': 'v' });
    const bad = { [testKeys.app]: { dir: '../kint', keys: { [testKeys.kid]: testKeys.key }, contentKeys: {} } };
    const fake = await startFakeMediaServer({ apps: bad, root, now: () => NOW_S * 1000 });
    try {
      expect((await get(fake.url, sign(`/${testKeys.app}/l/v.mp4`))).status).toBe(403);
      expect(fake.requests[0]!.verify).toEqual({ ok: false, status: 403, reason: 'apps-invalid' });
      expect((await get(fake.url, '/healthz')).status).toBe(204);
      expect((await get(fake.url, `/${testKeys.app}/l/v.mp4`, { method: 'OPTIONS' })).status).toBe(204);
    } finally {
      await fake.close();
    }
  });
});

describe('tesztvezérlés', () => {
  const BODY = Buffer.from('abcdefghij');
  let fake: FakeMediaServer;
  let nowMs = NOW_S * 1000;
  const path = `/${testKeys.app}/l/v.mp4`;
  beforeAll(async () => {
    fake = await startFakeMediaServer({
      apps: testKeys.apps,
      root: rootWith({ 'l/v.mp4': BODY }),
      now: () => nowMs,
      routes: { '/__control': (_req, res) => void res.writeHead(200, { 'content-type': 'text/plain' }).end('vezérlő') },
    });
  });
  afterAll(() => fake.close());
  afterEach(() => {
    fake.override = null;
    fake.requests.length = 0;
    nowMs = NOW_S * 1000;
  });

  it('override: status (a tokentől függetlenül), delayMs, body (Range-dzsel), headers', async () => {
    fake.override = { status: 500 };
    expect((await get(fake.url, '/bcdn_token=x/a/b.mp4')).status).toBe(500);
    expect(fake.requests[0]).toMatchObject({ status: 500, verify: { ok: false, status: 403 } });

    fake.override = { delayMs: 150 };
    const t0 = Date.now();
    expect((await get(fake.url, sign(path))).status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);

    fake.override = { body: Buffer.from('más törzs'), headers: { 'Content-Encoding': 'gzip', 'content-type': 'audio/wav' } };
    const res = await get(fake.url, sign(path));
    expect(res.body.toString()).toBe('más törzs');
    expect(res.headers).toMatchObject({ 'content-encoding': 'gzip', 'content-type': 'audio/wav' });
    expect((await get(fake.url, sign(path), { headers: { range: 'bytes=0-3' } })).body.toString()).toBe('más');
    // A body is csak érvényes tokenre.
    expect((await get(fake.url, `/bcdn_token=x${path}`)).status).toBe(403);
  });

  it('override: truncateAt rövid 206-ot ad; függvényként visszatartható, és a token az elengedés utáni órával dől el', async () => {
    fake.override = { truncateAt: 4 };
    const short = await get(fake.url, sign(path), { headers: { range: 'bytes=1-' } });
    expect(short).toMatchObject({ status: 206, headers: { 'content-range': 'bytes 1-3/10' } });
    expect(short.body.toString()).toBe('bcd');
    expect((await get(fake.url, sign(path))).body).toEqual(BODY);

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    fake.override = async (req) => {
      seen.push(req.range ?? '');
      if (req.range === 'bytes=5-') await held;
      return null;
    };
    const pending = get(fake.url, sign(path), { headers: { range: 'bytes=5-' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.requests.at(-1)).toMatchObject({ status: 0, verify: { ok: true } });
    nowMs += 3600 * 1000;
    release();
    expect((await pending).status).toBe(410);
    expect(fake.requests.at(-1)).toMatchObject({ status: 410, verify: { ok: false, reason: 'expired' } });
    expect(seen).toEqual(['bytes=5-']);
  });

  it('routes: saját végpont a médiakérések előtt, napló nélkül; close() többször hívható', async () => {
    const res = await get(fake.url, '/__control?x=1');
    expect(res.body.toString()).toBe('vezérlő');
    expect(fake.requests).toEqual([]);
    const other = await startFakeMediaServer({ apps: testKeys.apps, root: rootWith() });
    await other.close();
    await other.close();
    await expect(get(other.url, '/healthz')).rejects.toThrow();
  });
});

describe('testKeys', () => {
  it('a vektorok kulcsai, érvényes apps.json, a createUrlSigner-nek közvetlenül adható', async () => {
    expect(testKeys).toMatchObject({ app: 'test-app', kid: '2026a', contentKid: '2026c' });
    expect(testKeys.apps).toEqual({
      'test-app': { dir: '.', keys: { '2026a': testKeys.key }, contentKeys: { '2026c': testKeys.contentKey } },
    });
    expect(testAppsFile({ app: 'mas', dir: 'm', origins: ['https://a.test'], corp: 'same-origin' })).toEqual({
      mas: { dir: 'm', keys: { '2026a': testKeys.key }, contentKeys: { '2026c': testKeys.contentKey }, origins: ['https://a.test'], corp: 'same-origin' },
    });
    expect(Object.isFrozen(testKeys)).toBe(true);
  });
});
