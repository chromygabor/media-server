// A kulcsazonosító (`kid`) és a kulcs alakja (SPEC 6.; terv 4.3, csomagterv WP32).
// A szabály a médiaszerveren az `server/njs/media.js` `ID_RE`-je és `KEY_RE`-je; az értékek bájtra azonosak
// (a szerver `test/config.spec.ts`-e a forrásszövegen ellenőrzi). Az eltérés a szerveren `403 apps-invalid`-ot adna.
// Az ES256 séma kulcsai (SPEC 2., 6.; aszimmetrikus terv 3.2): a nyilvános kulcs a
// tömörítetlen P-256 pont base64url-ben, a titkos kulcs PKCS#8 DER base64url-ben (csak az appnál).

import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

/** `kid` (és a token `u` paramétere): rövid, URL-biztos azonosító; a `&` és `=` kizárva (a `signing_data` egyértelmű). */
export const KEY_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** Kulcs az `apps.json`-ban: base64 / base64url szöveg, legalább 43 jel (≈ 32 bájt entrópia), legfeljebb két `=`. */
export const KEY_RE = /^[A-Za-z0-9+/_-]{43,}={0,2}$/;

/** Érvényes kulcsazonosító-e (`KEY_ID_RE`); nem szöveg → `false`. */
export function isValidKeyId(value: unknown): boolean {
  return typeof value === 'string' && KEY_ID_RE.test(value);
}

/** Érvényes kulcs-e (`KEY_RE`); nem szöveg → `false`. A kulcs szövegét a hívó ne naplózza. */
export function isValidKey(value: unknown): boolean {
  return typeof value === 'string' && KEY_RE.test(value);
}

/**
 * ES256 nyilvános kulcs az `apps.json`-ban: a tömörítetlen P-256 pont (65 bájt: `0x04` ‖ X ‖ Y) kanonikus
 * base64url-ben, 87 jel. Az első két jel a `0x04` bájtot rögzíti (`B`, majd `A`–`P`), az utolsó jel 2 kitöltő bitje
 * nulla. A görbén-rajta-létet a regex nem nézi (`checkPublicKeys`, illetve a szerveren a `check-apps.js`).
 */
export const PUBLIC_KEY_RE = /^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]$/;
/** A titkos kulcs szövege: PKCS#8 DER base64url (kitöltés nélkül). */
const PRIVATE_KEY_TEXT_RE = /^[A-Za-z0-9_-]{16,}$/;
/** A P-256 SPKI DER fejléce (`SEQUENCE { id-ecPublicKey, prime256v1 }, BIT STRING`); utána a 65 bájtos pont. */
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

/** Érvényes alakú ES256 nyilvános kulcs-e (`PUBLIC_KEY_RE`); nem szöveg → `false`. A görbét nem nézi. */
export function isValidPublicKey(value: unknown): boolean {
  return typeof value === 'string' && PUBLIC_KEY_RE.test(value);
}

/** P-256 kulcs-e (`ec`, `prime256v1`) a megadott típussal. */
function isP256(key: KeyObject, type: 'private' | 'public'): boolean {
  return key.type === type && key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
}

/**
 * A titkos kulcs `KeyObject`-ként: a szöveg PKCS#8 DER base64url, P-256; `KeyObject` esetén csak a fajtát nézi.
 * Hibánál `RangeError`, amely a kulcsot nem idézi.
 */
export function parsePrivateKey(privateKey: string | KeyObject): KeyObject {
  let key: KeyObject | undefined;
  if (typeof privateKey === 'string') {
    if (PRIVATE_KEY_TEXT_RE.test(privateKey)) {
      try {
        key = createPrivateKey({ key: Buffer.from(privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
      } catch {
        key = undefined;
      }
    }
  } else if (privateKey !== null && typeof privateKey === 'object') {
    key = privateKey;
  }
  if (key === undefined || !isP256(key, 'private')) {
    throw new RangeError('media-sdk: érvénytelen titkos kulcs (PKCS#8 DER base64url, P-256 kell)');
  }
  return key;
}

/** Érvényes ES256 titkos kulcs-e (PKCS#8 DER base64url, P-256). A kulcs szövegét a hívó ne naplózza. */
export function isValidPrivateKey(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    parsePrivateKey(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * A nyilvános kulcs `KeyObject`-ként (a `PUBLIC_KEY_RE` alakból, SPKI-burokkal); ha az alak hibás vagy a pont nincs a
 * görbén, `undefined`.
 */
export function importPublicKey(publicKey: string): KeyObject | undefined {
  if (!isValidPublicKey(publicKey)) return undefined;
  try {
    const der = Buffer.concat([P256_SPKI_PREFIX, Buffer.from(publicKey, 'base64url')]);
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    return isP256(key, 'public') ? key : undefined;
  } catch {
    return undefined;
  }
}

/** A nyilvános kulcs `PUBLIC_KEY_RE` alakja egy P-256 `KeyObject`-ből (titkosból vagy nyilvánosból). */
export function rawPublicKey(key: KeyObject): string {
  const jwk = (key.type === 'private' ? createPublicKey(key) : key).export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new RangeError('media-sdk: nem P-256 kulcs');
  }
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString(
    'base64url',
  );
}
