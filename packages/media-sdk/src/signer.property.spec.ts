// Property-tesztek az URL-aláíróra (csomagterv WP34): minden kiadott URL átmegy a `verifySignedPath`-on a lejáratig;
// az elutasítás oka egy regex nélküli referencia-szabállyal egyezik, és ugyanarra a bemenetre mindig ugyanaz.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MEDIA_CONTENT_TYPES } from './path.js';
import { type SignRefusal, createUrlSigner } from './signer.js';
import { appLookupFrom, verifySignedPath } from './token.js';

const SAFE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.';
const segChar = fc.constantFrom(...SAFE.split(''));
const rawSegment = fc.array(segChar, { minLength: 1, maxLength: 10 }).map((cs) => cs.join(''));
const segment = rawSegment.filter((s) => !s.startsWith('.') && !s.startsWith('_'));
const id = fc.array(segChar, { minLength: 1, maxLength: 40 }).map((cs) => cs.join(''));
const key = fc.string({ minLength: 1, maxLength: 64 });
const ext = fc.constantFrom('.mp4', '.m4a', '.jpg', '.mp3', '.json', '.json.gz', '', '.MP4');
const hex = fc.array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 64, maxLength: 64 }).map((cs) => cs.join(''));

/** Az assetKey: többnyire a hatókörön belül, néha kívül, `_`-os vagy nem biztonságos (`..`, `.x`, üres szegmens, `%`). */
const assetKey = (scopeDir: string) =>
  fc.oneof(
    { weight: 6, arbitrary: fc.tuple(fc.array(segment, { maxLength: 2 }), segment, ext).map(([dirs, base, e]) => `${scopeDir}${[...dirs, base + e].join('/')}`) },
    { weight: 1, arbitrary: fc.tuple(segment, ext).map(([base, e]) => `other/${base}${e}`) },
    { weight: 1, arbitrary: fc.tuple(segment, ext).map(([base, e]) => `_${base}/${scopeDir}${base}${e}`) },
    {
      weight: 2,
      arbitrary: fc.tuple(fc.constantFrom('../', '.', '/', '%2F', 'a b/', ''), segment, ext).map(([bad, base, e]) => `${scopeDir}${bad}${base}${e}`),
    },
  );

const directoryCase = fc
  .record({
    app: segment,
    dirs: fc.array(segment, { minLength: 1, maxLength: 3 }),
    kid: id,
    key,
    userId: id,
    now: fc.integer({ min: 1, max: 3_000_000_000 }),
    maxTtl: fc.integer({ min: 1, max: 100_000 }),
    expOffset: fc.option(fc.integer({ min: 0, max: 200_000 }), { nil: null }),
  })
  .chain((r) => {
    const scopeDir = `${r.dirs.join('/')}/`;
    return fc
      .array(fc.record({ assetKey: assetKey(scopeDir), sha256: fc.option(hex, { nil: undefined }) }), { minLength: 1, maxLength: 6 })
      .map((assets) => ({ ...r, scopeDir, assets }));
  });

/** Referencia (regex nélkül): a szűrés sorrendje a csomagterv WP34 / a backend mai szabálya szerint. */
function refRefusal(app: string, scopeDir: string, assetKey: string): SignRefusal | null {
  if (assetKey.startsWith('_')) return 'reserved';
  if (!assetKey.startsWith(scopeDir)) return 'out-of-scope';
  const segments = [app, ...assetKey.split('/')];
  const safe = (s: string) => s.length > 0 && !s.startsWith('.') && s.split('').every((c) => SAFE.includes(c));
  if (!segments.every(safe)) return 'unsafe';
  const file = segments[segments.length - 1]!;
  const dot = file.lastIndexOf('.');
  if (dot <= 0 || !Object.hasOwn(MEDIA_CONTENT_TYPES, file.slice(dot))) return 'unsupported-type';
  return null;
}

describe('createUrlSigner property', () => {
  it('signDirectory: minden URL átmegy a verifySignedPath-on a lejáratig, utána 410; az elutasítás a referencia szerint', () => {
    fc.assert(
      fc.property(directoryCase, (c) => {
        const signer = createUrlSigner({ baseUrl: 'https://m.test', app: c.app, kid: c.kid, key: c.key, maxTtlSeconds: c.maxTtl, now: () => c.now * 1000 });
        const tokenExp = c.expOffset === null ? null : c.now + c.expOffset;
        const input = { scopeDir: c.scopeDir, userId: c.userId, tokenExp, assets: c.assets };
        const out = signer.signDirectory(input);
        const expires = Math.min(tokenExp ?? Infinity, c.now + c.maxTtl);
        expect(out.expiresAt.getTime()).toBe(expires * 1000);
        const lookup = appLookupFrom({ [c.app]: { keys: { [c.kid]: c.key }, contentKeys: {} } });
        out.results.forEach((r, i) => {
          const asset = c.assets[i]!;
          const expected = refRefusal(c.app, c.scopeDir, asset.assetKey);
          if (expected !== null) {
            expect(r).toEqual({ error: expected });
            return;
          }
          if (!('url' in r)) throw new Error(`várt URL, kapott: ${JSON.stringify(r)}`);
          const uri = r.url.slice('https://m.test'.length);
          expect(verifySignedPath(uri, lookup, c.now)).toMatchObject({ ok: true, app: c.app, kid: c.kid, u: c.userId, kind: 'browser' });
          expect(verifySignedPath(uri, lookup, expires)).toMatchObject({ ok: true });
          expect(verifySignedPath(uri, lookup, expires + 1)).toMatchObject({ ok: false, status: 410 });
          expect(uri.endsWith(asset.sha256 === undefined ? `/${c.app}/${asset.assetKey}` : `/${c.app}/${asset.assetKey}?v=${asset.sha256.slice(0, 12)}`)).toBe(true);
        });
        // Stabil: ugyanaz a bemenet és óra → ugyanaz a kimenet.
        expect(signer.signDirectory(input)).toEqual(out);
      }),
      { numRuns: 300 },
    );
  });

  it('signDirectory: hibás hatókörnél minden elem bad-scope', () => {
    const badScope = fc.oneof(
      segment, // nincs záró /
      segment.map((s) => `_${s}/`),
      fc.tuple(segment, fc.constantFrom('../', './', '//', '%2F/', '.x/')).map(([s, bad]) => `${s}/${bad}`),
      fc.constant(''),
      fc.constant('/'),
    );
    fc.assert(
      fc.property(segment, badScope, fc.array(fc.string({ maxLength: 20 }), { maxLength: 4 }), (app, scopeDir, keys) => {
        const signer = createUrlSigner({ baseUrl: '', app, kid: 'k', key: 'x', maxTtlSeconds: 60, now: () => 0 });
        const out = signer.signDirectory({ scopeDir, userId: 'u', assets: keys.map((assetKey) => ({ assetKey })) });
        expect(out.results).toEqual(keys.map(() => ({ error: 'bad-scope' })));
      }),
    );
  });

  it('signContentFile: biztonságos verzióra az URL a tartalomkulccsal ellenőrizhető; különben unsafe', () => {
    fc.assert(
      fc.property(segment, rawSegment, id, key, fc.integer({ min: 1, max: 3_000_000_000 }), (app, version, kid, k, now) => {
        const signer = createUrlSigner({ baseUrl: 'https://m.test', app, contentKid: kid, contentKey: k, now: () => now * 1000 });
        const out = signer.signContentFile(version);
        if (version.startsWith('.')) {
          expect(out).toEqual({ error: 'unsafe' });
          return;
        }
        if (!('url' in out)) throw new Error(`várt URL, kapott: ${JSON.stringify(out)}`);
        const uri = out.url.slice('https://m.test'.length);
        const lookup = appLookupFrom({ [app]: { keys: {}, contentKeys: { [kid]: k } } });
        expect(verifySignedPath(uri, lookup, now)).toMatchObject({ ok: true, kind: 'content', kid });
        expect(verifySignedPath(uri, lookup, now + 301)).toMatchObject({ ok: false, status: 410 });
        expect(signer.signContentFile(version)).toEqual(out);
      }),
    );
  });
});
