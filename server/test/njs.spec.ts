// Az njs/media.js Node alatt (implementációs terv WP2 7.; aszimmetrikus terv WP52): a közös vektorokon (a felső
// szintű verify és az es256.verify) ugyanazt a status-t ÉS reason-t adja, mint a TS (`@chromygabor/media-sdk`),
// véletlen módosításokon is, mindkét sémára (a verify aszinkron: await); az apps.json betöltéskori ellenőrzése; a
// kapu (js_content) egy r-csonkkal: a js_var-ok, az átirányítás, a hibaszámláló egy ngx.shared-csonkkal.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appLookupFrom, buildSignedPath, verifySignedPath, type AppKeys, type VerifyResult } from '@chromygabor/media-sdk';
import media, { type AppConfig, type NjsRequest, type NjsSharedDict } from '../njs/media.js';

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
interface Es256Block {
  kid: string;
  privateKey: string;
  publicKey: string;
  contentKid: string;
  contentPrivateKey: string;
  contentPublicKey: string;
  tokens: { name: string; expires: number; urlPath: string; params: { kid: string; u?: string } }[];
  verify: VerifyVector[];
}
const vectors = JSON.parse(readFileSync(require.resolve('@chromygabor/media-sdk/test-vectors.json'), 'utf8')) as {
  version: number;
  sign: SignVector[];
  verify: VerifyVector[];
  es256: Es256Block;
};
const es = vectors.es256;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/apps.test.json', import.meta.url), 'utf8')) as Record<
  string,
  AppConfig
>;

/** A két eredmény összevethető alakja. */
function shape(r: VerifyResult | Awaited<ReturnType<typeof media.verify>>): Record<string, unknown> {
  return r.ok
    ? { status: 200, app: r.app, kid: r.kid, u: r.u, path: r.path, assetKey: r.assetKey, kind: r.kind, contentType: r.contentType }
    : { status: r.status, reason: r.reason };
}

describe('közös vektorok (verify, es256.verify)', () => {
  it('1-es verzió', () => expect(vectors.version).toBe(1));
  it.each([...vectors.verify, ...es.verify].map((v) => [v.name, v] as const))('%s', async (_name, v) => {
    const r = await media.verify(v.requestUri, v.keys, v.now);
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
  it.each(vectors.sign.map((v) => [v.name, v] as const))('%s: a lejáratig elfogadva, utána 410', async (_name, v) => {
    const app = v.path.split('/')[1] as string;
    const keys = { [app]: { keys: { [v.params.kid]: v.key }, contentKeys: { [v.params.kid]: v.key } } };
    expect((await media.verify(v.expectedUrlPath, keys, v.expires)).ok).toBe(true);
    expect(await media.verify(v.expectedUrlPath, keys, v.expires + 1)).toEqual({ ok: false, status: 410, reason: 'expired' });
  });

  it.each(es.tokens.map((t) => [t.name, t] as const))('ES256 rögzített token (%s): a lejáratig elfogadva, utána 410', async (_name, t) => {
    const app = t.urlPath.split('/').filter(Boolean)[1] as string;
    const keys = { [app]: { keys: {}, contentKeys: {}, publicKeys: { [es.kid]: es.publicKey }, contentPublicKeys: { [es.contentKid]: es.contentPublicKey } } };
    expect(await media.verify(t.urlPath, keys, t.expires)).toMatchObject({ ok: true, kid: t.params.kid });
    expect(await media.verify(t.urlPath, keys, t.expires + 1)).toEqual({ ok: false, status: 410, reason: 'expired' });
  });

  it('ES256 oda-vissza: az sdk aláír (véletlenszerűen), az njs elfogadja; két aláírás különbözik', async () => {
    const keys = { elearning: { keys: {}, contentKeys: {}, publicKeys: { [es.kid]: es.publicKey } } };
    const input = { privateKey: es.privateKey, kid: es.kid, u: 'u1', tokenPath: '/elearning/t/', expires: 2_000_000_000, path: '/elearning/t/a.mp4' };
    const a = buildSignedPath(input);
    const b = buildSignedPath(input);
    expect(a).not.toBe(b);
    for (const uri of [a, b]) expect(await media.verify(uri, keys, 1_900_000_000)).toMatchObject({ ok: true, kid: es.kid, u: 'u1' });
  });

  it('low-S bájtonként (BigInt nélkül): s = n/2 még low, n/2 + 1 már nem; magas-S token → bad-signature', async () => {
    const sig = new Uint8Array(64);
    const half = Buffer.from('7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8', 'hex');
    sig.set(half, 32);
    expect(media.isLowS(sig)).toBe(true);
    sig[63] = 0xa9;
    expect(media.isLowS(sig)).toBe(false);
    sig.fill(0xff, 32);
    expect(media.isLowS(sig)).toBe(false);
    sig.fill(0, 32);
    expect(media.isLowS(sig)).toBe(true);
    const high = es.verify.find((v) => v.name.includes('magas-S'))!;
    expect(await media.verify(high.requestUri, high.keys, high.now)).toEqual({ ok: false, status: 403, reason: 'bad-signature' });
  });

  it('görbén kívüli (vagy hibás) nyilvános kulcs kérésidőben: 403 internal-error, kivétel és elutasítás nélkül', async () => {
    const good = es.verify[0]!;
    const off = `BA${'A'.repeat(84)}A`;
    const keys = { elearning: { ...good.keys.elearning!, publicKeys: { [es.kid]: off } } };
    expect(media.validateApps({ elearning: { dir: 'e', ...keys.elearning } })).toEqual([]); // az alak rendben
    expect(await media.verify(good.requestUri, keys, good.now)).toEqual({ ok: false, status: 403, reason: 'internal-error' });
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

  it('HS256: aláírt URI-n és módosításain azonos eredmény (status, reason, mezők)', async () => {
    await fc.assert(
      fc.asyncProperty(signed, fc.array(mutation, { maxLength: 3 }), fc.integer({ min: -10, max: 10 }), async (s, ms, dt) => {
        const uri = ms.reduce(mutate, s.uri);
        const keys = { [s.app]: { keys: { [s.kid]: s.key }, contentKeys: { [`${s.kid}c`]: s.key } } };
        const now = s.expires + dt;
        expect(shape(await media.verify(uri, keys, now))).toEqual(shape(verifySignedPath(uri, appLookupFrom(keys), now)));
      }),
      { numRuns: 2000 },
    );
  });

  it('ES256: aláírt URI-n és módosításain azonos eredmény; a kid mindkét sémában (wrong-scheme)', async () => {
    const esSigned = fc
      .record({
        app: segment,
        dirs: fc.array(segment, { maxLength: 3 }),
        base: segment,
        ext: fc.constantFrom('.mp4', '.m4a', '.jpg', '.json.gz'),
        depth: fc.nat(),
        u: fc.option(segment, { nil: undefined }),
        expires: fc.integer({ min: 1, max: 4_000_000_000 }),
      })
      .map((r) => {
        const content = r.ext === '.json.gz';
        const parents = content ? [r.app, '_content'] : [r.app, ...r.dirs];
        const path = `/${parents.join('/')}/${r.base}${r.ext}`;
        const tokenPath = content ? path : `/${parents.slice(0, 1 + (r.depth % parents.length)).join('/')}/`;
        const kid = content ? es.contentKid : es.kid;
        const privateKey = content ? es.contentPrivateKey : es.privateKey;
        const u = content ? undefined : r.u;
        return { ...r, uri: buildSignedPath({ privateKey, kid, u, tokenPath, expires: r.expires, path }) };
      });
    await fc.assert(
      fc.asyncProperty(esSigned, fc.array(mutation, { maxLength: 2 }), fc.integer({ min: -2, max: 2 }), fc.boolean(), async (s, ms, dt, hmacToo) => {
        const uri = ms.reduce(mutate, s.uri);
        const keys = {
          [s.app]: {
            keys: (hmacToo ? { hk: 'A'.repeat(43) } : {}) as Record<string, string>,
            contentKeys: {},
            publicKeys: { [es.kid]: es.publicKey },
            contentPublicKeys: { [es.contentKid]: es.contentPublicKey },
          },
        };
        const now = s.expires + dt;
        expect(shape(await media.verify(uri, keys, now))).toEqual(shape(verifySignedPath(uri, appLookupFrom(keys), now)));
      }),
      { numRuns: 400 },
    );
  });

  it('tetszőleges szövegen azonos eredmény', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 200 }), async (uri) => {
        const keys = { elearning: { keys: { a: 'k' }, contentKeys: {}, publicKeys: { e: es.publicKey } } };
        expect(shape(await media.verify(uri, keys, 0))).toEqual(shape(verifySignedPath(uri, appLookupFrom(keys), 0)));
      }),
      { numRuns: 1000 },
    );
  });
});

describe('validateApps (betöltéskori ellenőrzés, terv 4.3)', () => {
  it('a teszt-fixture rendben', () => expect(media.validateApps(fixture)).toEqual([]));
  it('a fixture minden kulcsa jelölt tesztkulcs; a nyilvános kulcsok a vektorok CSAK TESZT kulcspárjaié', () => {
    for (const a of Object.values(fixture)) {
      for (const k of [...Object.values(a.keys ?? {}), ...Object.values(a.contentKeys ?? {})]) {
        expect(k).toMatch(/^CSAK-TESZT-.*NEM-ELES/);
      }
      for (const k of [...Object.values(a.publicKeys ?? {}), ...Object.values(a.contentPublicKeys ?? {})]) {
        expect([es.publicKey, es.contentPublicKey]).toContain(k);
      }
    }
    expect(fixture.elearning).toMatchObject({ publicKeys: { t2026e: es.publicKey }, contentPublicKeys: { t2026f: es.contentPublicKey } });
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
    ['kid-ütközés', withApp({ keys: { a: 'A'.repeat(43) }, contentKeys: { a: 'B'.repeat(43) } }), 'több kulcstérképben is szerepel'],
    ['kid-ütközés HMAC és ES256 között', withApp({ publicKeys: { a: es.publicKey } }), 'több kulcstérképben is szerepel'],
    ['kid-ütközés a két nyilvános térkép között', withApp({ publicKeys: { e: es.publicKey }, contentPublicKeys: { e: es.contentPublicKey } }), 'több kulcstérképben'],
    ['ugyanaz a nyilvános kulcs mindkét fajtában', withApp({ publicKeys: { e: es.publicKey }, contentPublicKeys: { f: es.publicKey } }), 'a publicKeys-ben is szerepel'],
    ['nyilvános kulcs rossz alakú', withApp({ publicKeys: { e: es.publicKey.slice(1) } }), 'nem 87 jeles'],
    ['nyilvános kulcs SPKI-ként', withApp({ publicKeys: { e: `MFkw${es.publicKey}` } }), 'nem 87 jeles'],
    ['nyilvános kulcs nem kanonikus utolsó jellel', withApp({ publicKeys: { e: `${es.publicKey.slice(0, -1)}B` } }), 'nem 87 jeles'],
    ['publicKeys nem objektum', withApp({ publicKeys: [] }), '.publicKeys: nem objektum'],
    ['contentPublicKeys null', withApp({ contentPublicKeys: null }), '.contentPublicKeys: nem objektum'],
    ['érvénytelen kid', withApp({ keys: { 'a&b': 'A'.repeat(43) } }), 'érvénytelen kid'],
    ['hiányzó keys', withApp({ keys: undefined }), '.keys: nem objektum'],
    ['origin *', withApp({ origins: ['*'] }), 'érvénytelen origin'],
    ['corp', withApp({ corp: 'any' }), '.corp'],
  ])('%s → hiba', (_n, apps, msg) => {
    const errors = media.validateApps(apps);
    expect(errors.join('\n')).toContain(msg);
  });

  it('dir "." és több szegmens engedett; az origins / corp és a két nyilvános térkép elhagyható', () => {
    expect(media.validateApps(withApp({ publicKeys: { e: es.publicKey }, contentPublicKeys: { f: es.contentPublicKey } }))).toEqual([]);
    expect(media.validateApps(withApp({ publicKeys: {}, contentPublicKeys: undefined }))).toEqual([]);
    expect(media.validateApps(withApp({ dir: '.' }))).toEqual([]);
    expect(media.validateApps(withApp({ dir: 'a/b' }))).toEqual([]);
    expect(media.validateApps(withApp({ origins: undefined, corp: undefined }))).toEqual([]);
  });
});


describe('nginx-bekötés: a kapu (js_content, js_var-ok, előtöltött apps)', () => {
  const g = globalThis as { apps?: unknown; ngx?: unknown };
  afterEach(() => {
    delete g.apps;
    delete g.ngx;
    vi.resetModules();
  });
  async function load(apps: unknown): Promise<typeof media> {
    vi.resetModules();
    g.apps = apps;
    return ((await import('../njs/media.js')) as { default: typeof media }).default;
  }
  const req = (uri: string, origin?: string, ip = '198.51.100.7'): NjsRequest => ({
    variables: { request_uri: uri, remote_addr: ip },
    headersIn: origin === undefined ? {} : { Origin: origin },
  });
  /** A kapu egy kérésre: a döntés (`redirect` a @serve-be vagy `return <státusz>`) és a js_var-ok. */
  async function gate(m: typeof media, uri: string, opts: { origin?: string; ip?: string } = {}) {
    const calls: Array<[string, string | number]> = [];
    const r: NjsRequest = {
      ...req(uri, opts.origin, opts.ip),
      return: (status) => void calls.push(['return', status]),
      internalRedirect: (to) => void calls.push(['redirect', to]),
    };
    await m.gate(r);
    expect(calls).toHaveLength(1);
    const v = r.variables;
    return {
      r,
      decision: calls[0]!,
      vars: [v.media_status, v.media_reason, v.media_file ?? '', v.media_app ?? '', v.media_kid ?? '', v.media_u ?? '', v.media_user_key ?? '', v.media_kind ?? ''],
    };
  }
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
  /** ES256-link a fixture `elearning` appjára (t2026e / t2026f: a vektorok CSAK TESZT kulcspárjai). */
  const esSign = (file: string, opts: { content?: boolean; u?: string; privateKey?: string } = {}) => {
    const path = `/elearning/${file}`;
    return buildSignedPath({
      privateKey: opts.privateKey ?? (opts.content ? es.contentPrivateKey : es.privateKey),
      kid: opts.content ? 't2026f' : 't2026e',
      u: opts.u,
      tokenPath: opts.content ? path : path.slice(0, path.lastIndexOf('/') + 1),
      expires: now + 3600,
      path,
    });
  };
  /** Magas-S változat: ugyanaz az aláírás `s → n − s`-sel (a WebCrypto elfogadná, a kapu nem). */
  const highS = (uri: string) =>
    uri.replace(/ES256-([A-Za-z0-9_-]{86})/, (_m, b64: string) => {
      const sig = Buffer.from(b64, 'base64url');
      const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
      const sv = BigInt(`0x${sig.subarray(32).toString('hex')}`);
      Buffer.from((n - sv).toString(16).padStart(64, '0'), 'hex').copy(sig, 32);
      return `ES256-${sig.toString('base64url')}`;
    });

  it('hibás vagy hiányzó apps.json → minden kérés 403 apps-invalid, kivétel nélkül', async () => {
    for (const apps of [{ x: { dir: '..', keys: {}, contentKeys: {} } }, undefined]) {
      const m = await load(apps);
      const { decision, vars } = await gate(m, sign('elearning', 't/a.mp4'), { origin: 'http://localhost:3000' });
      expect(decision).toEqual(['return', 403]);
      expect(vars).toEqual(['403', 'apps-invalid', '', '', '', '', '', '']);
      expect(m.corsOrigin(req(sign('elearning', 't/a.mp4'), 'http://localhost:3000'))).toBe('');
    }
  });

  it('böngészős token u-val: @serve, fájl a dir alatt, napló-mezők, limit-kulcs, cache a js_var-ból', async () => {
    const m = await load(fixture);
    const { r, decision, vars } = await gate(m, `${sign('elearning', 't/lessons/ch-01-l01/m01.720p.mp4', { u: 'user-1' })}?x=1`);
    expect(decision).toEqual(['redirect', '@serve']);
    expect(vars).toEqual(['ok', '', '/elearning/t/lessons/ch-01-l01/m01.720p.mp4', 'elearning', 't2026a', 'user-1', 'elearning user-1', 'browser']);
    expect(m.path(r)).toBe('/elearning/t/lessons/ch-01-l01/m01.720p.mp4');
    expect(m.cache(r)).toBe('private, max-age=3600');
    expect(m.corp(r)).toBe('same-site');
  });

  it('dir "." → a fájl közvetlenül a /srv/media alatt; u nélkül üres limit-kulcs', async () => {
    const m = await load(fixture);
    const { r, vars } = await gate(m, sign('helyi', 't/x/a.jpg'));
    expect(vars).toEqual(['ok', '', '/t/x/a.jpg', 'helyi', 't2026a', '', '', 'browser']);
    expect(m.corp(r)).toBe('cross-origin');
  });

  it('mélyebb _-os szegmens: csak az app utáni első számít (SPEC 3.), böngészős token, fájl a dir alatt', async () => {
    const m = await load(fixture);
    const uri = sign('elearning', 't/_x/m.mp4');
    expect((await gate(m, uri)).vars.slice(0, 3)).toEqual(['ok', '', '/elearning/t/_x/m.mp4']);
    expect(await media.verify(uri, fixture, now)).toMatchObject({ ok: true, kind: 'browser', assetKey: 't/_x/m.mp4' });
    expect(shape(await media.verify(uri, fixture, now))).toEqual(
      shape(verifySignedPath(uri, appLookupFrom(fixture as Record<string, Required<AppConfig>>), now)),
    );
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
      return buildSignedPath({ key, kid, tokenPath: `/${app}/t/`, expires: now + 3600, path: `/${app}/t/a.mp4` });
    };
    const a = await gate(m, signFor('egyik', 'egyik'));
    const b = await gate(m, signFor('masodik', 'masodik'));
    expect(a.vars.slice(0, 3)).toEqual(['ok', '', '/kozos/t/a.mp4']);
    expect(b.vars.slice(0, 3)).toEqual(['ok', '', '/kozos/t/a.mp4']);
    const ra = req(signFor('egyik', 'egyik'), 'https://egyik.example');
    const rb = req(signFor('masodik', 'masodik'), 'https://egyik.example');
    expect([m.corp(ra), m.corsOrigin(ra)]).toEqual(['same-site', 'https://egyik.example']);
    expect([m.corp(rb), m.corsOrigin(rb)]).toEqual(['cross-origin', '']);
    expect(m.corsOrigin(req(signFor('masodik', 'masodik'), 'https://masodik.example'))).toBe('https://masodik.example');
    // A másik app kulcsával aláírt link (a kulcsok különböznek): 403.
    const wrong = await gate(m, signFor('masodik', 'egyik'));
    expect([wrong.decision, wrong.vars.slice(0, 3)]).toEqual([['return', 403], ['403', 'bad-signature', '']]);
  });

  it('tartalomtoken: @serve, kind content, no-store', async () => {
    const m = await load(fixture);
    const { r, vars } = await gate(m, sign('elearning', '_content/2026.11.23-1.json.gz', { content: true }));
    expect(vars).toEqual(['ok', '', '/elearning/_content/2026.11.23-1.json.gz', 'elearning', 't2026c', '', '', 'content']);
    expect(m.cache(r)).toBe('no-store');
  });

  it('ES256 (vegyes app): böngészős és tartalom → @serve; wrong-scheme mindkét irányban; magas-S és idegen kulcspár 403', async () => {
    const m = await load(fixture);
    expect((await gate(m, esSign('t/lessons/ch-01-l01/m01.720p.mp4', { u: 'user-1' }))).vars).toEqual([
      'ok', '', '/elearning/t/lessons/ch-01-l01/m01.720p.mp4', 'elearning', 't2026e', 'user-1', 'elearning user-1', 'browser',
    ]);
    expect((await gate(m, esSign('_content/v.json.gz', { content: true }))).vars).toEqual([
      'ok', '', '/elearning/_content/v.json.gz', 'elearning', 't2026f', '', '', 'content',
    ]);
    const hsWithEsKid = buildSignedPath({ key: fixture.elearning!.keys!.t2026a!, kid: 't2026e', tokenPath: '/elearning/t/', expires: now + 60, path: '/elearning/t/a.mp4' });
    const esWithHsKid = buildSignedPath({ privateKey: es.privateKey, kid: 't2026a', tokenPath: '/elearning/t/', expires: now + 60, path: '/elearning/t/a.mp4' });
    for (const [uri, reason] of [
      [hsWithEsKid, 'wrong-scheme'],
      [esWithHsKid, 'wrong-scheme'],
      [highS(esSign('t/a.mp4')), 'bad-signature'],
      [esSign('t/a.mp4', { privateKey: es.contentPrivateKey }), 'bad-signature'],
      [esSign('_content/v.json.gz', { content: true }).replace('kid=t2026f', 'kid=t2026e'), 'wrong-key-kind'],
    ] as const) {
      const { decision, vars } = await gate(m, uri);
      expect([decision, vars.slice(0, 3)], reason).toEqual([['return', 403], ['403', reason, '']]);
    }
  });

  it('hibák: 403 / 404 / 410 ok-kal (törzs nélküli r.return → error_page), üres fájl és felhasználó, a naplóútvonalban nincs token', async () => {
    const m = await load(fixture);
    const cases: Array<[string, number, string]> = [
      ['/elearning/t/a.mp4', 403, 'missing-token'],
      [sign('masik', 't/a.mp4').replace('/masik/', '/elearning/'), 403, 'bad-signature'],
      [sign('elearning', 't/a.mp4').replace('/a.mp4', '/a.mp4.build.json'), 404, 'not-servable'],
      [sign('elearning', 't/a.mp4', { expires: now - 10 }), 410, 'expired'],
    ];
    for (const [uri, status, reason] of cases) {
      const { r, decision, vars } = await gate(m, uri);
      expect(decision).toEqual(['return', status]);
      expect(vars).toEqual([String(status), reason, '', '', '', '', '', '']);
      expect(m.path(r)).not.toContain('bcdn_token');
      expect(m.cache(r)).toBe('no-store');
    }
  });

  /** Az `ngx.shared.media_fails` csonkja (type=number): `incr` a timeout-tal, lejárat egy óra szerint. */
  function fakeZone(clock: { ms: number }) {
    const data = new Map<string, { n: number; until: number }>();
    const incrCalls: unknown[][] = [];
    const live = (k: string) => {
      const e = data.get(k);
      if (e !== undefined && e.until <= clock.ms) data.delete(k);
      return data.get(k);
    };
    const zone: NjsSharedDict = {
      get: (k) => live(k)?.n,
      incr: (k, delta, init = 0, timeout = Infinity) => {
        incrCalls.push([k, delta, init, timeout]);
        const e = live(k) ?? { n: init, until: clock.ms + timeout };
        e.n += delta;
        data.set(k, e);
        return e.n;
      },
    };
    return { zone, incrCalls, data };
  }

  it(`hibaszámláló (D116): ${media.FAILS_LIMIT} hibás ES256-aláírás után az IP 429 blocked (aláírás nélkül); HMAC-ra nem hat; lejár`, async () => {
    expect([media.FAILS_LIMIT, media.FAILS_WINDOW_MS]).toEqual([50, 10_000]);
    const clock = { ms: 0 };
    const { zone, incrCalls } = fakeZone(clock);
    g.ngx = { shared: { media_fails: zone } };
    const m = await load(fixture);
    const ip = '203.0.113.9';
    const bad = highS(esSign('t/a.mp4'));
    const good = esSign('t/a.mp4');
    for (let i = 0; i < media.FAILS_LIMIT; i++) {
      expect((await gate(m, bad, { ip })).vars.slice(0, 2)).toEqual(['403', 'bad-signature']);
    }
    expect(incrCalls).toHaveLength(media.FAILS_LIMIT);
    expect(incrCalls[0]).toEqual([ip, 1, 0, media.FAILS_WINDOW_MS]);
    // Blokk: az érvényes ES256-kérés is 429 (az aláírás előtt), a hibás sem számol tovább.
    const blocked = await gate(m, good, { ip });
    expect([blocked.decision, blocked.vars]).toEqual([['return', 429], ['429', 'blocked', '', '', '', '', '', '']]);
    expect((await gate(m, bad, { ip })).decision).toEqual(['return', 429]);
    expect(incrCalls).toHaveLength(media.FAILS_LIMIT);
    // Az olcsó elővizsgálat (alak, kid, séma) a blokk előtt: ugyanúgy 403 az okkal.
    expect((await gate(m, esSign('t/a.mp4').replace('kid=t2026e', 'kid=nincs'), { ip })).vars.slice(0, 2)).toEqual(['403', 'unknown-kid']);
    // HMAC-ra nem hat (sem a blokk, sem a számlálás), és más IP-t nem érint.
    expect((await gate(m, sign('elearning', 't/a.mp4'), { ip })).decision).toEqual(['redirect', '@serve']);
    expect((await gate(m, sign('masik', 't/a.mp4').replace('/masik/', '/elearning/'), { ip: '203.0.113.10' })).vars[1]).toBe('bad-signature');
    expect(incrCalls).toHaveLength(media.FAILS_LIMIT);
    expect((await gate(m, good, { ip: '203.0.113.10' })).decision).toEqual(['redirect', '@serve']);
    // A lejárat (explicit timeout) után újra ellenőriz.
    clock.ms = media.FAILS_WINDOW_MS;
    expect((await gate(m, good, { ip })).decision).toEqual(['redirect', '@serve']);
  });

  it('a számláló hibája nem változtat a döntésen; nginx nélkül (Node, njs CLI) nincs számláló', async () => {
    g.ngx = { shared: { media_fails: { get: () => undefined, incr: () => { throw new Error('tele'); } } } };
    let m = await load(fixture);
    expect((await gate(m, highS(esSign('t/a.mp4')))).vars.slice(0, 2)).toEqual(['403', 'bad-signature']);
    delete g.ngx;
    m = await load(fixture);
    for (let i = 0; i < media.FAILS_LIMIT + 5; i++) await gate(m, highS(esSign('t/a.mp4')));
    expect((await gate(m, esSign('t/a.mp4'))).decision).toEqual(['redirect', '@serve']);
  });

  it('görbén kívüli nyilvános kulcs kérésidőben: 403 internal-error, nem számol', async () => {
    const clock = { ms: 0 };
    const { zone, incrCalls } = fakeZone(clock);
    g.ngx = { shared: { media_fails: zone } };
    const off = `BA${'A'.repeat(84)}A`;
    const m = await load({ ...fixture, elearning: { ...fixture.elearning, publicKeys: { t2026e: off } } });
    expect((await gate(m, esSign('t/a.mp4'))).vars.slice(0, 2)).toEqual(['403', 'internal-error']);
    expect(incrCalls).toEqual([]);
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

  it('az előtöltött apps tömbjein nincs Array.prototype-metódus (njs js_preload_object): a CORS és a kapu így is működik', async () => {
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
    expect((await gate(m, sign('elearning', 't/a.mp4'))).decision).toEqual(['redirect', '@serve']);
    expect((await gate(m, esSign('t/a.mp4'))).decision).toEqual(['redirect', '@serve']);
  });

  it('kivétel nem jut ki (az error_logba a tokennel): 403 internal-error', async () => {
    const m = await load(fixture);
    const calls: unknown[] = [];
    const variables = {
      remote_addr: '198.51.100.1',
      get request_uri(): string {
        throw new Error('x');
      },
    } as NjsRequest['variables'];
    const bad: NjsRequest = { variables, headersIn: {}, return: (st) => void calls.push(st), internalRedirect: () => void calls.push('redirect') };
    await expect(m.gate(bad)).resolves.toBeUndefined();
    expect([calls, variables.media_status, variables.media_reason]).toEqual([[403], '403', 'internal-error']);
    expect(m.corsOrigin(bad)).toBe('');
    // Ha maga a válasz dob (pl. már döntött), az sem jut ki.
    const throwing: NjsRequest = { variables: { request_uri: '/x', remote_addr: '1' }, headersIn: {}, return: () => { throw new Error('y'); } };
    await expect(m.gate(throwing)).resolves.toBeUndefined();
  });

  it('headers (js_header_filter): beállít, nem hozzáfűz; Cache-Control a tényleges állapotból és a $media_kind-ből', async () => {
    const m = await load(fixture);
    const uri = sign('elearning', 't/lessons/ch-01-l01/m01.720p.mp4', { u: 'user-1' });
    const run = (status: number, origin?: string, kind = 'browser'): Record<string, string | undefined> => {
      const base = req(uri, origin);
      const r: NjsRequest = { ...base, variables: { ...base.variables, media_kind: kind }, headersOut: {}, status };
      m.headers(r);
      m.headers(r); // a 416-nál a fejlécszűrők kétszer futnak: ugyanaz az eredmény
      return r.headersOut ?? {};
    };
    for (const st of [200, 206, 304]) expect(run(st)['Cache-Control']).toBe('private, max-age=3600');
    for (const st of [200, 206]) expect(run(st, undefined, 'content')['Cache-Control']).toBe('no-store');
    // A fő location OPTIONS 204-e és 405-e (a kapu nem futott: a $media_kind üres).
    for (const st of [200, 204, 405]) expect(run(st, undefined, '')['Cache-Control']).toBe('no-store');
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
