// `./apps-config` (csomagterv WP33): validateAppsFile szabályai (SPEC 6.) és hogy a hibaüzenet kulcsot nem idéz. Az njs
// `validateApps`-szel való paritást a médiaszerver `test/config.spec.ts`-e ellenőrzi.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { APP_CORP_VALUES, isValidAppName, validateAppsFile } from './apps-config.js';

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
