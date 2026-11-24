// A kulcsazonosító és a kulcs validátorai (csomagterv WP32; az ES256 kulcsok: aszimmetrikus terv WP50): példák és property-tesztek egy regex nélküli
// referencia-szabály ellen. Az njs-sel való paritás a médiaszerver `test/config.spec.ts`-ében.

import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  importPublicKey,
  isValidKey,
  isValidKeyId,
  isValidPrivateKey,
  isValidPublicKey,
  KEY_ID_RE,
  KEY_RE,
  parsePrivateKey,
  PUBLIC_KEY_RE,
} from './keys.js';

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

describe('ES256 kulcsok (SPEC 2., 6.): PUBLIC_KEY_RE, isValidPublicKey, isValidPrivateKey', () => {
  const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  /** Referencia: pontosan 65 bájt kanonikus base64url-ben, az első bájt 0x04. */
  const refPublicKey = (s: string): boolean => {
    if (s.length !== 87 || !s.split('').every((c) => B64URL.includes(c))) return false;
    const bytes = Buffer.from(s, 'base64url');
    return bytes.length === 65 && bytes[0] === 4 && bytes.toString('base64url') === s;
  };
  const rawOf = (k: KeyObject): string => {
    const jwk = k.export({ format: 'jwk' });
    return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x as string, 'base64url'), Buffer.from(jwk.y as string, 'base64url')]).toString(
      'base64url',
    );
  };

  it('valódi P-256 kulcsok tömörítetlen pontja mindig illeszkedik (a kitöltő bitek miatt az utolsó jel 16-féle lehet)', () => {
    const last = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const pub = rawOf(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey);
      expect(PUBLIC_KEY_RE.test(pub)).toBe(true);
      expect(isValidPublicKey(pub)).toBe(true);
      last.add(pub.slice(-1));
    }
    expect(last.size).toBeGreaterThan(4);
  });

  it('property: egyezik a referencia-szabállyal (bájtszintű dekódolás)', () => {
    const pubLike = fc.uint8Array({ minLength: 64, maxLength: 64 }).map((b) => Buffer.concat([Buffer.from([4]), b]).toString('base64url'));
    const near = fc.tuple(pubLike, fc.nat(86), fc.constantFrom(...B64URL.split(''))).map(([s, i, c]) => s.slice(0, i) + c + s.slice(i + 1));
    fc.assert(fc.property(fc.oneof(pubLike, near, fc.string({ maxLength: 90 })), (s) => isValidPublicKey(s) === refPublicKey(s)));
  });

  it.each([
    ['tömörített pont (33 B)', Buffer.concat([Buffer.from([2]), Buffer.alloc(32, 7)]).toString('base64url')],
    ['SPKI', generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')],
    ['kitöltéssel', `${rawOf(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey)}=`],
    ['0x05 első bájt', Buffer.concat([Buffer.from([5]), Buffer.alloc(64, 1)]).toString('base64url')],
  ])('elutasít: %s', (_n, s) => expect(isValidPublicKey(s)).toBe(false));

  it('nem szöveg → false', () => {
    for (const v of [undefined, null, 1, {}]) {
      expect(isValidPublicKey(v)).toBe(false);
      expect(isValidPrivateKey(v)).toBe(false);
    }
  });

  it('isValidPrivateKey: PKCS#8 DER base64url P-256 igen; más görbe, Ed25519, SEC1, PEM, szemét nem', () => {
    const p256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    expect(isValidPrivateKey(p256.export({ format: 'der', type: 'pkcs8' }).toString('base64url'))).toBe(true);
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey;
    expect(isValidPrivateKey(p384.export({ format: 'der', type: 'pkcs8' }).toString('base64url'))).toBe(false);
    const ed = generateKeyPairSync('ed25519').privateKey;
    expect(isValidPrivateKey(ed.export({ format: 'der', type: 'pkcs8' }).toString('base64url'))).toBe(false);
    expect(isValidPrivateKey(p256.export({ format: 'der', type: 'sec1' }).toString('base64url'))).toBe(false);
    expect(isValidPrivateKey(p256.export({ format: 'pem', type: 'pkcs8' }) as string)).toBe(false);
    expect(isValidPrivateKey(p256.export({ format: 'der', type: 'pkcs8' }).toString('base64'))).toBe(false);
    expect(isValidPrivateKey('a'.repeat(184))).toBe(false);
    expect(isValidPrivateKey('')).toBe(false);
  });

  it('parsePrivateKey: a hibaüzenet a kulcsot nem idézi', () => {
    const secret = 'CSAKTESZTtitkosKulcsSzovegNemPKCS8-0123456789abcdef';
    expect(() => parsePrivateKey(secret)).toThrow(RangeError);
    try {
      parsePrivateKey(secret);
    } catch (e) {
      expect((e as Error).message).not.toContain(secret.slice(0, 12));
    }
  });

  it('importPublicKey: a görbén kívüli pont (helyes alakkal) undefined, a valódi P-256 pont KeyObject', () => {
    const pub = rawOf(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey);
    expect(importPublicKey(pub)?.asymmetricKeyType).toBe('ec');
    const bytes = Buffer.from(pub, 'base64url');
    bytes[64] = (bytes[64] as number) ^ 1; // Y utolsó bitje: a pont lekerül a görbéről
    const off = bytes.toString('base64url');
    expect(isValidPublicKey(off)).toBe(true);
    expect(importPublicKey(off)).toBeUndefined();
  });
});
