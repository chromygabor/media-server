// `./apps-config` (csomagterv WP33): validateAppsFile szabályai (SPEC 6.) és hogy a hibaüzenet kulcsot nem idéz. Az njs
// `validateApps`-szel való paritást a médiaszerver `test/config.spec.ts`-e ellenőrzi.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addPublicKey,
  APP_CORP_VALUES,
  checkPublicKeys,
  defaultKid,
  generateKeyPair,
  isValidAppName,
  publicKeyOf,
  validateAppsFile,
  type AppsFile,
} from './apps-config.js';
import { isValidPrivateKey, PUBLIC_KEY_RE } from './keys.js';

const K = 'A'.repeat(43);
const good = () => ({ app1: { dir: 'app1', keys: { a: K }, contentKeys: { c: 'B'.repeat(43) }, origins: [], corp: 'same-site' } });
const withApp = (patch: Record<string, unknown>) => ({ app1: { ...good().app1, ...patch } });
const errorsOf = (v: unknown): string[] => {
  const r = validateAppsFile(v);
  return r.ok ? [] : r.errors;
};

describe('validateAppsFile', () => {
  it('érvényes: ok + ugyanaz az objektum', () => {
    const apps = good();
    expect(validateAppsFile(apps)).toEqual({ ok: true, apps });
    const r = validateAppsFile(apps);
    expect(r.ok && r.apps).toBe(apps);
  });

  it.each([
    ['nem objektum', [], 'a gyökér nem objektum'],
    ['null', null, 'a gyökér nem objektum'],
    ['üres', {}, 'nincs egy app sem'],
    ['_-os app-név', { _x: good().app1 }, 'apps["_x"]: érvénytelen app-név'],
    ['.-os app-név', { '.x': good().app1 }, 'érvénytelen app-név'],
    ['app nem objektum', { app1: [] }, 'apps["app1"]: nem objektum'],
    ['dir ..', withApp({ dir: '../x' }), '.dir'],
    ['dir abszolút', withApp({ dir: '/srv' }), '.dir'],
    ['dir üres', withApp({ dir: '' }), '.dir'],
    ['dir hiányzik', withApp({ dir: undefined }), '.dir'],
    ['rövid kulcs', withApp({ keys: { a: 'rovid' } }), '43 jeles'],
    ['nem szöveg kulcs', withApp({ keys: { a: 42 } }), '43 jeles'],
    ['kid-ütközés', withApp({ keys: { a: K }, contentKeys: { a: K } }), 'is szerepel: a'],
    ['érvénytelen kid', withApp({ keys: { 'a&b': K } }), 'érvénytelen kid: a&b'],
    ['hiányzó keys', withApp({ keys: undefined }), '.keys: nem objektum'],
    ['contentKeys tömb', withApp({ contentKeys: [] }), '.contentKeys: nem objektum'],
    ['origins nem tömb', withApp({ origins: 'https://a.b' }), '.origins: nem tömb'],
    ['origin *', withApp({ origins: ['*'] }), 'érvénytelen origin: *'],
    ['origin útvonallal', withApp({ origins: ['https://a.b/'] }), 'érvénytelen origin'],
    ['corp', withApp({ corp: 'any' }), '.corp: érvénytelen érték'],
  ])('%s → hiba', (_n, apps, msg) => {
    expect(errorsOf(apps).join('\n')).toContain(msg);
  });

  it('dir "." és több szegmens, közös dir, üres kulcstérképek engedettek; az origins / corp elhagyható', () => {
    expect(errorsOf(withApp({ dir: '.' }))).toEqual([]);
    expect(errorsOf(withApp({ dir: 'a/b' }))).toEqual([]);
    expect(errorsOf(withApp({ origins: undefined, corp: undefined }))).toEqual([]);
    expect(errorsOf(withApp({ keys: {}, contentKeys: {}, origins: ['http://localhost:3000'] }))).toEqual([]);
    expect(errorsOf({ ...good(), app2: { ...good().app1, dir: 'app1' } })).toEqual([]);
    for (const corp of APP_CORP_VALUES) expect(errorsOf(withApp({ corp }))).toEqual([]);
  });

  it('app-név: biztonságos szegmens, nem _-os', () => {
    expect(isValidAppName('elearning-dev')).toBe(true);
    for (const n of ['', '_x', '.x', 'a/b', 'a b']) expect(isValidAppName(n)).toBe(false);
  });

  it('a kulcsnak látszó app-nevet, kid-et és origint nem idézi (pl. felcserélt kid és kulcs)', () => {
    const key = 'Zm9vYmFyLXRpdGtvcy1rdWxjcy1uZS1sYXRzem9keW9uLTAx+/==';
    const errors = errorsOf({
      app1: { dir: 'app1', keys: { [key]: '2026a' }, contentKeys: { [key]: K }, origins: [key] },
      [key]: { dir: 'x', keys: {}, contentKeys: {} },
    });
    expect(errors.length).toBeGreaterThanOrEqual(5);
    expect(errors.join('\n')).toContain('apps["app1"].keys: érvénytelen kid: #1');
    expect(errors.join('\n')).toContain('apps[#2]: érvénytelen app-név');
    for (const e of errors) expect(e).not.toContain(key.slice(0, 20));
  });

  it('property: a kulcs szövege soha nincs a hibaüzenetben', () => {
    const keyLike = fc.stringMatching(/^[A-Za-z0-9+/_-]{43,60}={0,2}$/);
    const anything = fc.oneof(keyLike, fc.string(), fc.integer(), fc.constant(null));
    fc.assert(
      fc.property(keyLike, anything, anything, fc.boolean(), (secret, other, kid, swap) => {
        const map = swap ? { [secret]: other } : { [String(kid)]: secret };
        const errors = errorsOf({ [swap ? secret : 'app']: { dir: 1, keys: map, contentKeys: map, origins: [secret, other] } });
        return errors.every((e) => !e.includes(secret));
      }),
    );
  });
});

describe('ES256: publicKeys / contentPublicKeys (SPEC 6.)', () => {
  const P1 = generateKeyPair().publicKey;
  const P2 = generateKeyPair().publicKey;
  const offCurve = (() => {
    const b = Buffer.from(P1, 'base64url');
    b[64] = (b[64] as number) ^ 1;
    return b.toString('base64url');
  })();

  it('elhagyható (a mai fájl érvényes marad); megadva érvényes', () => {
    expect(errorsOf(good())).toEqual([]);
    expect(errorsOf(withApp({ publicKeys: { e: P1 }, contentPublicKeys: { f: P2 } }))).toEqual([]);
    expect(errorsOf(withApp({ publicKeys: {}, contentPublicKeys: {} }))).toEqual([]);
  });

  it.each([
    ['publicKeys tömb', withApp({ publicKeys: [] }), '.publicKeys: nem objektum'],
    ['contentPublicKeys null', withApp({ contentPublicKeys: null }), '.contentPublicKeys: nem objektum'],
    ['érvénytelen kid', withApp({ publicKeys: { 'a b': P1 } }), '.publicKeys: érvénytelen kid: a b'],
    ['HMAC-kulcs nyilvános kulcsként', withApp({ publicKeys: { e: K } }), 'nem 87 jeles, tömörítetlen P-256 pont'],
    ['tömörített pont', withApp({ publicKeys: { e: `A${P1.slice(1, 44)}` } }), 'P-256 pont'],
    ['nem szöveg', withApp({ contentPublicKeys: { f: 1 } }), 'P-256 pont'],
    ['kid-ütközés keys ↔ publicKeys', withApp({ publicKeys: { a: P1 } }), 'több kulcstérképben is szerepel: a'],
    ['kid-ütközés contentKeys ↔ contentPublicKeys', withApp({ contentPublicKeys: { c: P1 } }), 'is szerepel: c'],
    ['kid-ütközés publicKeys ↔ contentPublicKeys', withApp({ publicKeys: { e: P1 }, contentPublicKeys: { e: P2 } }), 'is szerepel: e'],
    ['ugyanaz a nyilvános kulcs mindkét fajtában', withApp({ publicKeys: { e: P1 }, contentPublicKeys: { f: P1 } }), 'a publicKeys-ben is szerepel'],
  ])('%s → hiba', (_n, apps, msg) => {
    const errors = errorsOf(apps);
    expect(errors.join('\n')).toContain(msg);
    expect(errors).toHaveLength(1);
  });

  it('a nyilvános kulcsot a hibaüzenet nem idézi', () => {
    const errors = errorsOf(withApp({ publicKeys: { e: P1, [P2]: P2 }, contentPublicKeys: { f: P1 } }));
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) {
      expect(e).not.toContain(P1.slice(0, 20));
      expect(e).not.toContain(P2.slice(0, 20));
    }
  });

  it('checkPublicKeys: a görbén kívüli pontot jelzi (a validateAppsFile alakra elfogadja), az érvényeset nem', () => {
    const apps = withApp({ publicKeys: { e: P1 }, contentPublicKeys: { f: offCurve } }) as AppsFile;
    expect(errorsOf(apps)).toEqual([]);
    expect(checkPublicKeys(apps)).toEqual(['apps["app1"].contentPublicKeys[f]: a nyilvános kulcs nem egy P-256 görbepont']);
    expect(checkPublicKeys(withApp({ publicKeys: { e: P1 } }) as AppsFile)).toEqual([]);
    expect(checkPublicKeys(good() as AppsFile)).toEqual([]);
  });

  it('generateKeyPair: a kimenet a regexeknek felel meg, a nyilvános kulcs a titkosból levezethető, minden hívás új', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const kp = generateKeyPair();
      expect(kp.publicKey).toMatch(PUBLIC_KEY_RE);
      expect(isValidPrivateKey(kp.privateKey)).toBe(true);
      expect(publicKeyOf(kp.privateKey)).toBe(kp.publicKey);
      seen.add(kp.publicKey);
    }
    expect(seen.size).toBe(50);
  });

  it('publicKeyOf: hibás titkos kulcsra RangeError, a kulcs idézése nélkül', () => {
    const secret = 'CSAKTESZThibasTitkosKulcs0123456789abcdefghij';
    expect(() => publicKeyOf(secret)).toThrow(RangeError);
    expect(() => publicKeyOf(secret)).not.toThrow(new RegExp(secret.slice(0, 12)));
  });

  it('defaultKid: HMAC a/c, ES256 e/f', () => {
    const now = new Date('2026-11-24T00:00:00Z');
    expect([defaultKid(false, now), defaultKid(true, now), defaultKid(false, now, true), defaultKid(true, now, true)]).toEqual([
      '2026a',
      '2026c',
      '2026e',
      '2026f',
    ]);
  });

  describe('addPublicKey', () => {
    const base = good() as AppsFile;
    it('hozzáad (böngészős és tartalom), a bemenet nem változik, az eredmény érvényes', () => {
      const a = addPublicKey(base, { app: 'app1', kid: '2026e', publicKey: P1, content: false });
      const b = addPublicKey(a, { app: 'app1', kid: '2026f', publicKey: P2, content: true });
      expect(b.app1?.publicKeys).toEqual({ '2026e': P1 });
      expect(b.app1?.contentPublicKeys).toEqual({ '2026f': P2 });
      expect(base.app1?.publicKeys).toBeUndefined();
      expect(validateAppsFile(b).ok).toBe(true);
      expect(checkPublicKeys(b)).toEqual([]);
    });
    it('új app az addKey alapértékeivel', () => {
      const r = addPublicKey(base, { app: 'uj-app', kid: '2026e', publicKey: P1, content: false });
      expect(r['uj-app']).toEqual({ dir: 'uj-app', keys: {}, contentKeys: {}, origins: [], corp: 'same-site', publicKeys: { '2026e': P1 } });
      expect(validateAppsFile(r).ok).toBe(true);
    });
    it.each([
      ['kid-ütközés (HMAC keys)', { kid: 'a', publicKey: P1 }, 'már létezik'],
      ['kid-ütközés (contentKeys)', { kid: 'c', publicKey: P1 }, 'már létezik'],
      ['érvénytelen kid', { kid: 'a b', publicKey: P1 }, 'érvénytelen kid'],
      ['HMAC-kulcs', { kid: 'e', publicKey: K }, 'érvénytelen nyilvános kulcs'],
      ['görbén kívüli pont', { kid: 'e', publicKey: offCurve }, 'érvénytelen nyilvános kulcs'],
    ])('elutasít: %s', (_n, over, msg) => {
      expect(() => addPublicKey(base, { app: 'app1', content: false, ...over })).toThrow(msg);
    });
    it('felülírás nincs; ugyanaz a nyilvános kulcs nem kerülhet be kétszer', () => {
      const a = addPublicKey(base, { app: 'app1', kid: '2026e', publicKey: P1, content: false });
      expect(() => addPublicKey(a, { app: 'app1', kid: '2026e', publicKey: P2, content: false })).toThrow('már létezik');
      expect(() => addPublicKey(a, { app: 'app1', kid: '2026f', publicKey: P1, content: true })).toThrow('már szerepel');
      expect(() => addPublicKey(base, { app: '_x', kid: 'e', publicKey: P1, content: false })).toThrow('app-név');
    });
  });
});
