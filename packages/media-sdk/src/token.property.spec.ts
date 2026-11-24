// Property tesztek (implementációs terv WP1 „Kész, ha”): verify(sign(x)) = ok; bármely egyjeles módosítás a
// token-szegmensben → nem ok; bucketExpires monoton, órán belül állandó, ≥ now + 5 h.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bucketExpires } from './expires.js';
import { appLookupFrom, buildSignedPath, verifySignedPath } from './token.js';

const segChar = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split(''));
const segment = fc
  .array(segChar, { minLength: 1, maxLength: 12 })
  .map((cs) => cs.join(''))
  .filter((s) => !s.startsWith('.') && !s.startsWith('_'));
const id = fc.array(segChar, { minLength: 1, maxLength: 40 }).map((cs) => cs.join(''));
const key = fc.string({ minLength: 1, maxLength: 64 });
const expires = fc.integer({ min: 1, max: 4_000_000_000 });

/** Böngészős link: /<app>/<dir…>/<fájl.ext>, token_path a fájl egyik ős-könyvtára. */
const browserCase = fc
  .record({
    app: segment,
    dirs: fc.array(segment, { minLength: 0, maxLength: 4 }),
    base: segment,
    ext: fc.constantFrom('.mp4', '.m4a', '.jpg'),
    depth: fc.nat(),
    kid: id,
    u: fc.option(id, { nil: undefined }),
    key,
    expires,
  })
  .map((r) => {
    const parents = [r.app, ...r.dirs];
    const keep = 1 + (r.depth % parents.length);
    return {
      ...r,
      path: `/${parents.join('/')}/${r.base}${r.ext}`,
      tokenPath: `/${parents.slice(0, keep).join('/')}/`,
      kind: 'browser' as const,
    };
  });

/** Tartalomlink: /<app>/_content/<v>.json.gz, fájlra szóló token_path, u nélkül. */
const contentCase = fc.record({ app: segment, v: segment, kid: id, key, expires }).map((r) => {
  const path = `/${r.app}/_content/${r.v}.json.gz`;
  return { ...r, u: undefined, path, tokenPath: path, kind: 'content' as const };
});

const anyCase = fc.oneof(browserCase, contentCase);

function lookupFor(c: { app: string; kid: string; key: string; kind: 'browser' | 'content' }) {
  const m = { [c.kid]: c.key };
  return appLookupFrom({ [c.app]: c.kind === 'browser' ? { keys: m, contentKeys: {} } : { keys: {}, contentKeys: m } });
}

describe('media-sdk property', () => {
  it('verify(sign(x)) = ok tetszőleges érvényes bemenetre, a lejáratig', () => {
    fc.assert(
      fc.property(anyCase, fc.nat(), (c, back) => {
        const uri = buildSignedPath(c);
        const now = Math.max(0, c.expires - back);
        const r = verifySignedPath(uri, lookupFor(c), now);
        expect(r).toMatchObject({ ok: true, app: c.app, kid: c.kid, u: c.u, path: c.path, kind: c.kind });
      }),
    );
  });

  it('bármely egyjeles módosítás a token-szegmensben → nem ok', () => {
    const printable = fc.integer({ min: 0x21, max: 0x7e }).map((n) => String.fromCharCode(n));
    fc.assert(
      fc.property(anyCase, fc.nat(), printable, (c, pos, ch) => {
        const uri = buildSignedPath(c);
        const segEnd = uri.indexOf('/', 1);
        const i = 1 + (pos % (segEnd - 1));
        fc.pre(uri[i] !== ch);
        const mutated = uri.slice(0, i) + ch + uri.slice(i + 1);
        expect(verifySignedPath(mutated, lookupFor(c), c.expires).ok).toBe(false);
      }),
    );
  });

  it('a lejárat után 410, előtte ok', () => {
    fc.assert(
      fc.property(anyCase, fc.integer({ min: 1, max: 1_000_000 }), (c, late) => {
        const r = verifySignedPath(buildSignedPath(c), lookupFor(c), c.expires + late);
        expect(r).toEqual({ ok: false, status: 410, reason: 'expired' });
      }),
    );
  });

  it('másik kulccsal aláírva → 403', () => {
    fc.assert(
      fc.property(anyCase, key, (c, other) => {
        fc.pre(other !== c.key);
        const r = verifySignedPath(buildSignedPath({ ...c, key: other }), lookupFor(c), c.expires);
        expect(r).toMatchObject({ ok: false, status: 403, reason: 'bad-signature' });
      }),
    );
  });

  describe('bucketExpires', () => {
    const now = fc.integer({ min: 0, max: 4_000_000_000 });
    it('≥ now + 5 h és ≤ now + 6 h', () => {
      fc.assert(
        fc.property(now, (n) => {
          const e = bucketExpires(n);
          expect(e).toBeGreaterThan(n + 5 * 3600);
          expect(e).toBeLessThanOrEqual(n + 6 * 3600);
        }),
      );
    });
    it('monoton', () => {
      fc.assert(
        fc.property(now, now, (a, b) => {
          expect(bucketExpires(Math.min(a, b))).toBeLessThanOrEqual(bucketExpires(Math.max(a, b)));
        }),
      );
    });
    it('egy órán belül állandó', () => {
      fc.assert(
        fc.property(now, fc.integer({ min: 0, max: 3599 }), (n, d) => {
          const start = Math.floor(n / 3600) * 3600;
          expect(bucketExpires(start + d)).toBe(bucketExpires(start));
        }),
      );
    });
  });
});
