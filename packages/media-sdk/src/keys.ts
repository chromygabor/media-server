// A kulcsazonosító (`kid`) és a kulcs alakja (terv 4.3; csomagterv WP32). A szabály a
// médiaszerveren az `server/njs/media.js` `ID_RE`-je és `KEY_RE`-je; az értékek bájtra azonosak (a szerver
// `test/config.spec.ts`-e a forrásszövegen ellenőrzi). Az eltérés a szerveren `403 apps-invalid`-ot adna.

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
