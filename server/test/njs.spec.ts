// Az njs/media.js Node alatt (implementációs terv WP2 7.): a közös vektorokon ugyanazt a status-t ÉS reason-t
// adja, mint a TS (`@chromygabor/media-sdk`), véletlen módosításokon is; az apps.json betöltéskori ellenőrzése;
// a js_set kimenetek egy r-csonkkal.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appLookupFrom, buildSignedPath, verifySignedPath, type AppKeys, type VerifyResult } from '@chromygabor/media-sdk';
import media, { type AppConfig, type NjsRequest } from '../njs/media.js';

interface VerifyVector {
  name: string;
  requestUri: string;
  keys: Record<string, AppKeys>;
  now: number;
  expected: { status: number; reason?: string; app?: string; kid?: string; u?: string; kind?: string; contentType?: string };
}
interface SignVector {
  name: string;
  key: string;
  tokenPath: string;
  expires: number;
  params: { kid: string; u?: string };
  path: string;
  expectedUrlPath: string;
}

const require = createRequire(import.meta.url);
const vectors = JSON.parse(readFileSync(require.resolve('@chromygabor/media-sdk/test-vectors.json'), 'utf8')) as {
  version: number;
  sign: SignVector[];
  verify: VerifyVector[];
};
const fixture = JSON.parse(readFileSync(new URL('./fixtures/apps.test.json', import.meta.url), 'utf8')) as Record<
  string,
  AppConfig
>;

/** A két eredmény összevethető alakja. */
function shape(r: VerifyResult | ReturnType<typeof media.verify>): Record<string, unknown> {
  return r.ok
    ? { status: 200, app: r.app, kid: r.kid, u: r.u, path: r.path, assetKey: r.assetKey, kind: r.kind, contentType: r.contentType }
    : { status: r.status, reason: r.reason };
}

describe('közös vektorok (verify)', () => {
  it('1-es verzió', () => expect(vectors.version).toBe(1));
  it.each(vectors.verify.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const r = media.verify(v.requestUri, v.keys, v.now);
    if (r.ok) {
      expect({ status: 200, app: r.app, kid: r.kid, ...(r.u ? { u: r.u } : {}), kind: r.kind, contentType: r.contentType }).toEqual(
        v.expected,
      );
    } else {
      expect({ status: r.status, reason: r.reason }).toEqual(v.expected);
    }
    expect(shape(r)).toEqual(shape(verifySignedPath(v.requestUri, appLookupFrom(v.keys), v.now)));
  });
});

describe('közös vektorok (sign → njs verify)', () => {
  it.each(vectors.sign.map((v) => [v.name, v] as const))('%s: a lejáratig elfogadva, utána 410', (_name, v) => {
    const app = v.path.split('/')[1] as string;
    const keys = { [app]: { keys: { [v.params.kid]: v.key }, contentKeys: { [v.params.kid]: v.key } } };
    expect(media.verify(v.expectedUrlPath, keys, v.expires).ok).toBe(true);
    expect(media.verify(v.expectedUrlPath, keys, v.expires + 1)).toEqual({ ok: false, status: 410, reason: 'expired' });
  });
});

describe('paritás a TS-sel véletlen bemeneteken (fast-check)', () => {
  const segChar = fc.constantFrom(...'abcxyzABC019-_.'.split(''));
  const segment = fc
    .array(segChar, { minLength: 1, maxLength: 8 })
    .map((cs) => cs.join(''))
    .filter((s) => !s.startsWith('.') && !s.startsWith('_'));
  const keyArb = fc.string({ minLength: 1, maxLength: 48 });
  const signed = fc
    .record({
      app: segment,
      dirs: fc.array(segment, { maxLength: 3 }),
      base: segment,
      ext: fc.constantFrom('.mp4', '.m4a', '.jpg'),
      depth: fc.nat(),
      kid: segment,
      u: fc.option(segment, { nil: undefined }),
      key: keyArb,
      expires: fc.integer({ min: 1, max: 4_000_000_000 }),
    })
    .map((r) => {
      const parents = [r.app, ...r.dirs];
      const tokenPath = `/${parents.slice(0, 1 + (r.depth % parents.length)).join('/')}/`;
      const path = `/${parents.join('/')}/${r.base}${r.ext}`;
      return { ...r, uri: buildSignedPath({ key: r.key, kid: r.kid, u: r.u, tokenPath, expires: r.expires, path }) };
    });
  /** Egy jel cseréje / beszúrása / törlése az URI tetszőleges pontján. */
  const mutation = fc.record({
    op: fc.constantFrom('replace', 'insert', 'delete'),
    pos: fc.nat(),
    ch: fc.constantFrom(...'aZ09-_./%&=?2F'.split('')),
  });
  function mutate(uri: string, m: { op: string; pos: number; ch: string }): string {
    const i = m.pos % (uri.length + 1);
    if (m.op === 'insert') return uri.slice(0, i) + m.ch + uri.slice(i);
    if (m.op === 'delete') return uri.slice(0, i) + uri.slice(i + 1);
    return uri.slice(0, i) + m.ch + uri.slice(i + 1);
  }

  it('aláírt URI-n és módosításain azonos eredmény (status, reason, mezők)', () => {
    fc.assert(
      fc.property(signed, fc.array(mutation, { maxLength: 3 }), fc.integer({ min: -10, max: 10 }), (s, ms, dt) => {
        const uri = ms.reduce(mutate, s.uri);
        const keys = { [s.app]: { keys: { [s.kid]: s.key }, contentKeys: { [`${s.kid}c`]: s.key } } };
        const now = s.expires + dt;
        expect(shape(media.verify(uri, keys, now))).toEqual(shape(verifySignedPath(uri, appLookupFrom(keys), now)));
      }),
      { numRuns: 2000 },
    );
  });

  it('tetszőleges szövegen azonos eredmény', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (uri) => {
        const keys = { elearning: { keys: { a: 'k' }, contentKeys: {} } };
        expect(shape(media.verify(uri, keys, 0))).toEqual(shape(verifySignedPath(uri, appLookupFrom(keys), 0)));
      }),
      { numRuns: 1000 },
    );
  });
});

describe('validateApps (betöltéskori ellenőrzés, terv 4.3)', () => {
  it('a teszt-fixture rendben', () => expect(media.validateApps(fixture)).toEqual([]));
  it('a fixture minden kulcsa jelölt tesztkulcs', () => {
    for (const a of Object.values(fixture)) {
      for (const k of [...Object.values(a.keys ?? {}), ...Object.values(a.contentKeys ?? {})]) {
        expect(k).toMatch(/^CSAK-TESZT-.*NEM-ELES/);
      }
    }
  });

  const good = (): Record<string, unknown> => ({
    app1: { dir: 'app1', keys: { a: 'A'.repeat(43) }, contentKeys: { c: 'B'.repeat(43) }, origins: [], corp: 'same-site' },
  });
  const withApp = (patch: Record<string, unknown>) => ({ app1: { ...(good().app1 as object), ...patch } });

  it.each([
    ['nem objektum', [], 'a gyökér nem objektum'],
    ['üres', {}, 'nincs egy app sem'],
    ['_-os app-név', { _x: (good() as { app1: unknown }).app1 }, 'érvénytelen app-név'],
    ['dir ..', withApp({ dir: '../x' }), '.dir'],
    ['dir abszolút', withApp({ dir: '/srv' }), '.dir'],
    ['dir üres', withApp({ dir: '' }), '.dir'],
    ['rövid kulcs', withApp({ keys: { a: 'rovid' } }), '43 jeles'],
    ['nem szöveg kulcs', withApp({ keys: { a: 42 } }), '43 jeles'],
    ['kid-ütközés', withApp({ keys: { a: 'A'.repeat(43) }, contentKeys: { a: 'B'.repeat(43) } }), 'is szerepel'],
    ['érvénytelen kid', withApp({ keys: { 'a&b': 'A'.repeat(43) } }), 'érvénytelen kid'],
    ['hiányzó keys', withApp({ keys: undefined }), '.keys: nem objektum'],
    ['origin *', withApp({ origins: ['*'] }), 'érvénytelen origin'],
    ['corp', withApp({ corp: 'any' }), '.corp'],
  ])('%s → hiba', (_n, apps, msg) => {
    const errors = media.validateApps(apps);
    expect(errors.join('\n')).toContain(msg);
  });

  it('dir "." és több szegmens engedett; az origins / corp elhagyható', () => {
    expect(media.validateApps(withApp({ dir: '.' }))).toEqual([]);
    expect(media.validateApps(withApp({ dir: 'a/b' }))).toEqual([]);
    expect(media.validateApps(withApp({ origins: undefined, corp: undefined }))).toEqual([]);
  });
});

describe('nginx-bekötés (js_set, előtöltött apps)', () => {
  const g = globalThis as { apps?: unknown };
  afterEach(() => {
    delete g.apps;
    vi.resetModules();
  });
  async function load(apps: unknown): Promise<typeof media> {
    vi.resetModules();
    g.apps = apps;
    return ((await import('../njs/media.js')) as { default: typeof media }).default;
  }
  let seq = 0;
  const req = (uri: string, origin?: string): NjsRequest => ({
    variables: { request_uri: uri, request_id: `r${++seq}` },
    headersIn: origin === undefined ? {} : { Origin: origin },
  });
  const now = Math.floor(Date.now() / 1000);
  const sign = (app: string, file: string, opts: { content?: boolean; u?: string; expires?: number } = {}) => {
    const a = fixture[app] as Required<AppConfig>;
    const [kid, key] = Object.entries(opts.content ? a.contentKeys : a.keys)[0] as [string, string];
    const path = `/${app}/${file}`;
    return buildSignedPath({
      key,
      kid,
      u: opts.u,
      tokenPath: opts.content ? path : path.slice(0, path.lastIndexOf('/') + 1),
      expires: opts.expires ?? now + 3600,
      path,
    });
  };

  it('hibás vagy hiányzó apps.json → minden kérés 403 apps-invalid, kivétel nélkül', async () => {
    for (const apps of [{ x: { dir: '..', keys: {}, contentKeys: {} } }, undefined]) {
      const m = await load(apps);
      const r = req(sign('elearning', 't/a.mp4'), 'http://localhost:3000');
      expect([m.status(r), m.reason(r), m.corsOrigin(r), m.file(r)]).toEqual(['403', 'apps-invalid', '', '']);
    }
  });

  it('böngészős token u-val: ok, fájl a dir alatt, napló-mezők, limit-kulcs, cache', async () => {
    const m = await load(fixture);
    const uri = `${sign('elearning', 't/lessons/ch-01-l01/m01.720p.mp4', { u: 'user-1' })}?x=1`;
    const r = req(uri);
    expect(m.status(r)).toBe('ok');
    expect(m.reason(r)).toBe('');
    expect(m.file(r)).toBe('/elearning/t/lessons/ch-01-l01/m01.720p.mp4');
    expect([m.app(r), m.kid(r), m.user(r), m.userKey(r)]).toEqual(['elearning', 't2026a', 'user-1', 'elearning user-1']);
    expect(m.path(r)).toBe('/elearning/t/lessons/ch-01-l01/m01.720p.mp4');
    expect(m.cache(r)).toBe('private, max-age=3600');
    expect(m.corp(r)).toBe('same-site');
  });

  it('dir "." → a fájl közvetlenül a /srv/media alatt; u nélkül üres limit-kulcs', async () => {
    const m = await load(fixture);
    const r = req(sign('helyi', 't/x/a.jpg'));
    expect(m.status(r)).toBe('ok');
    expect(m.file(r)).toBe('/t/x/a.jpg');
    expect(m.userKey(r)).toBe('');
    expect(m.corp(r)).toBe('cross-origin');
  });

  it('mélyebb _-os szegmens: csak az app utáni első számít (SPEC 3.), böngészős token, fájl a dir alatt', async () => {
    const m = await load(fixture);
    const uri = sign('elearning', 't/_x/m.mp4');
    const r = req(uri);
    expect([m.status(r), m.reason(r), m.file(r)]).toEqual(['ok', '', '/elearning/t/_x/m.mp4']);
    expect(media.verify(uri, fixture, now)).toMatchObject({ ok: true, kind: 'browser', assetKey: 't/_x/m.mp4' });
    expect(shape(media.verify(uri, fixture, now))).toEqual(shape(verifySignedPath(uri, appLookupFrom(fixture as Record<string, Required<AppConfig>>), now)));
  });

  it('közös dir (SPEC 6.): két app ugyanazt a fájlt látja, a CORP és a CORS appenként a sajátja, más app kulcsával 403', async () => {
    const shared: Record<string, Required<AppConfig>> = {
      egyik: { ...(fixture.elearning as Required<AppConfig>), dir: 'kozos', origins: ['https://egyik.example'], corp: 'same-site' },
      masodik: { ...(fixture.masik as Required<AppConfig>), dir: 'kozos', origins: ['https://masodik.example'], corp: 'cross-origin' },
    };
    expect(media.validateApps(shared)).toEqual([]);
    const m = await load(shared);
    const signFor = (app: string, keyApp: string) => {
      const [kid, key] = Object.entries(shared[keyApp]!.keys)[0] as [string, string];
      const path = `/${app}/t/a.mp4`;
      return buildSignedPath({ key, kid, tokenPath: `/${app}/t/`, expires: now + 3600, path });
    };
    const a = req(signFor('egyik', 'egyik'), 'https://egyik.example');
    const b = req(signFor('masodik', 'masodik'), 'https://egyik.example');
    expect([m.status(a), m.file(a), m.corp(a), m.corsOrigin(a)]).toEqual(['ok', '/kozos/t/a.mp4', 'same-site', 'https://egyik.example']);
    expect([m.status(b), m.file(b), m.corp(b), m.corsOrigin(b)]).toEqual(['ok', '/kozos/t/a.mp4', 'cross-origin', '']);
    expect(m.corsOrigin(req(signFor('masodik', 'masodik'), 'https://masodik.example'))).toBe('https://masodik.example');
    // A másik app kulcsával aláírt link (a kulcsok különböznek): 403.
    const wrong = req(signFor('masodik', 'egyik'));
    expect([m.status(wrong), m.reason(wrong), m.file(wrong)]).toEqual(['403', 'bad-signature', '']);
  });

  it('tartalomtoken: ok, no-store', async () => {
    const m = await load(fixture);
    const r = req(sign('elearning', '_content/2026.11.23-1.json.gz', { content: true }));
    expect(m.status(r)).toBe('ok');
    expect(m.file(r)).toBe('/elearning/_content/2026.11.23-1.json.gz');
    expect(m.cache(r)).toBe('no-store');
  });

  it('hibák: 403 / 404 / 410 ok-kal, üres fájl és felhasználó, a naplóútvonalban nincs token', async () => {
    const m = await load(fixture);
    const cases: Array<[string, string, string]> = [
      ['/elearning/t/a.mp4', '403', 'missing-token'],
      [sign('masik', 't/a.mp4').replace('/masik/', '/elearning/'), '403', 'bad-signature'],
      [sign('elearning', 't/a.mp4').replace('/a.mp4', '/a.mp4.build.json'), '404', 'not-servable'],
      [sign('elearning', 't/a.mp4', { expires: now - 10 }), '410', 'expired'],
    ];
    for (const [uri, status, reason] of cases) {
      const r = req(uri);
      expect([m.status(r), m.reason(r), m.file(r), m.user(r), m.app(r)]).toEqual([status, reason, '', '', '']);
      expect(m.path(r)).not.toContain('bcdn_token');
      expect(m.cache(r)).toBe('no-store');
    }
  });

  it('CORS: csak az app saját originje (a token ellenőrzése nélkül, preflighthoz)', async () => {
    const m = await load(fixture);
    const uri = sign('elearning', 't/a.mp4');
    expect(m.corsOrigin(req(uri, 'https://elearning.example.test'))).toBe('https://elearning.example.test');
    expect(m.corsOrigin(req('/elearning/t/a.mp4', 'http://localhost:3000'))).toBe('http://localhost:3000');
    expect(m.corsOrigin(req(uri, 'https://gonosz.example'))).toBe('');
    expect(m.corsOrigin(req(uri))).toBe('');
    expect(m.corsOrigin(req(sign('masik', 't/a.mp4'), 'https://elearning.example.test'))).toBe('');
    expect(m.corsOrigin(req('/constructor/x.mp4', 'https://elearning.example.test'))).toBe('');
  });

  it('az előtöltött apps tömbjein nincs Array.prototype-metódus (njs js_preload_object): a CORS így is működik', async () => {
    const strip = (v: unknown): unknown => {
      if (Array.isArray(v)) {
        const a = v.map(strip);
        for (const name of ['indexOf', 'includes', 'map', 'some', 'find', 'forEach', 'join', 'filter']) {
          Object.defineProperty(a, name, { value: undefined });
        }
        return a;
      }
      if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)]));
      return v;
    };
    const m = await load(strip(fixture));
    expect(m.corsOrigin(req(sign('elearning', 't/a.mp4'), 'http://localhost:3000'))).toBe('http://localhost:3000');
    expect(m.status(req(sign('elearning', 't/a.mp4')))).toBe('ok');
  });

  it('kivétel nem jut ki (az error_logba a tokennel): 403 internal-error', async () => {
    const m = await load(fixture);
    const bad = { variables: { request_id: 'x1', get request_uri(): string { throw new Error('x'); } }, headersIn: {} } as NjsRequest;
    expect([m.status(bad), m.reason(bad), m.corsOrigin(bad)]).toEqual(['403', 'internal-error', '']);
  });

  it('headers (js_header_filter): beállít, nem hozzáfűz; Cache-Control a tényleges állapotból', async () => {
    const m = await load(fixture);
    const uri = sign('elearning', 't/lessons/ch-01-l01/m01.720p.mp4', { u: 'user-1' });
    const run = (status: number, origin?: string): Record<string, string | undefined> => {
      const r: NjsRequest = { ...req(uri, origin), headersOut: {}, status };
      m.headers(r);
      m.headers(r); // a 416-nál a fejlécszűrők kétszer futnak: ugyanaz az eredmény
      return r.headersOut ?? {};
    };
    for (const st of [200, 206, 304]) expect(run(st)['Cache-Control']).toBe('private, max-age=3600');
    for (const st of [416, 503, 405, 204]) expect(run(st)['Cache-Control']).toBe('no-store');
    // D100 (WP39): a 405 megnevezi az engedett metódusokat, más állapot nem kap Allow-t.
    expect(run(405).Allow).toBe('GET, HEAD, OPTIONS');
    for (const st of [200, 206, 204, 403, 416]) expect(run(st).Allow).toBeUndefined();
    expect(run(200)).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
      'Cross-Origin-Resource-Policy': 'same-site',
      'Cache-Control': 'private, max-age=3600',
      Vary: 'Origin',
    });
    expect(run(206, 'http://localhost:3000')).toMatchObject({
      'Access-Control-Allow-Origin': 'http://localhost:3000',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, If-Range',
      'Access-Control-Max-Age': '600',
    });
  });

  it('denied: 403, rövid szöveges törzs', async () => {
    const m = await load(fixture);
    const calls: unknown[] = [];
    const r: NjsRequest = { ...req('/x'), headersOut: {}, return: (status, body) => calls.push([status, body]) };
    m.denied(r);
    expect(calls).toEqual([[403, 'forbidden\n']]);
    expect(r.headersOut?.['Content-Type']).toBe('text/plain');
  });

  it('plainPath: query és token-szegmens levágva', () => {
    expect(media.plainPath('/bcdn_token=x&expires=1/a/b.mp4?bcdn_token=y')).toBe('/a/b.mp4');
    expect(media.plainPath('/bcdn_token=x')).toBe('');
    expect(media.plainPath('/healthz')).toBe('/healthz');
  });
});
