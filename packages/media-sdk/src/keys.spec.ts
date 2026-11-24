// A kulcsazonosító és a kulcs validátorai (csomagterv WP32): példák és property-tesztek egy regex nélküli
// referencia-szabály ellen. Az njs-sel való paritás a médiaszerver `test/config.spec.ts`-ében.

import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isValidKey, isValidKeyId, KEY_ID_RE, KEY_RE } from './keys.js';

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-';
const KEY_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/_-';

/** Referencia: 1–128 jel a `[A-Za-z0-9._-]` halmazból. */
const refKeyId = (s: string): boolean => s.length >= 1 && s.length <= 128 && s.split('').every((c) => ID_CHARS.includes(c));
/** Referencia: legalább 43 jel a `[A-Za-z0-9+/_-]` halmazból, utána legfeljebb két `=`. */
const refKey = (s: string): boolean => {
  const body = s.replace(/={1,2}$/, '');
  return body.length >= 43 && body.split('').every((c) => KEY_CHARS.includes(c));
};

/** Vegyes jelkészlet: a megengedett jelek, `=`, és néhány tipikus hibás jel (szóköz, `&`, ékezet, sorvég). */
const mixedChar = fc.constantFrom(...`${KEY_CHARS}.=& \náé%`.split(''));
const mixed = (maxLength: number) => fc.array(mixedChar, { maxLength }).map((cs) => cs.join(''));

describe('KEY_ID_RE / isValidKeyId', () => {
  it.each(['t2026a', 'a', 'kid.2026-11_a', 'x'.repeat(128)])('elfogad: %j', (s) => {
    expect(isValidKeyId(s)).toBe(true);
    expect(KEY_ID_RE.test(s)).toBe(true);
  });

  it.each(['', 'x'.repeat(129), 'a b', 'a&b', 'a=b', 'a/b', 'á', 'a\n', 'a%2F'])('elutasít: %j', (s) =>
    expect(isValidKeyId(s)).toBe(false),
  );

  it('nem szöveg → false', () => {
    for (const v of [undefined, null, 1, {}, ['t2026a']]) expect(isValidKeyId(v)).toBe(false);
  });

  it('property: egyezik a referencia-szabállyal', () => {
    fc.assert(fc.property(fc.oneof(mixed(140), fc.string({ maxLength: 140 })), (s) => isValidKeyId(s) === refKeyId(s)));
  });
});

describe('KEY_RE / isValidKey', () => {
  it.each([
    'a'.repeat(43),
    `${'A'.repeat(42)}+/`,
    `${'a'.repeat(43)}=`,
    `${'a'.repeat(43)}==`,
    'CSAK-TESZT-kulcs-elearning-bongeszos-NEM-ELES-0001',
  ])('elfogad: %j', (s) => {
    expect(isValidKey(s)).toBe(true);
    expect(KEY_RE.test(s)).toBe(true);
  });

  it.each(['', 'a'.repeat(42), `${'a'.repeat(42)}=`, `${'a'.repeat(43)}===`, `${'a'.repeat(43)} `, `${'a'.repeat(42)}.`])(
    'elutasít: %j',
    (s) => expect(isValidKey(s)).toBe(false),
  );

  it('nem szöveg → false', () => {
    for (const v of [undefined, null, 1, {}, ['a'.repeat(43)]]) expect(isValidKey(v)).toBe(false);
  });

  it('property: egyezik a referencia-szabállyal', () => {
    fc.assert(fc.property(fc.oneof(mixed(80), fc.string({ maxLength: 80 })), (s) => isValidKey(s) === refKey(s)));
  });

  it('property: a 32 véletlen bájt base64 és base64url alakja is érvényes kulcs', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 64 }), (bytes) => {
        const buf = Buffer.from(bytes);
        return isValidKey(buf.toString('base64')) && isValidKey(buf.toString('base64url'));
      }),
    );
    expect(isValidKey(randomBytes(32).toString('base64url'))).toBe(true);
  });
});
