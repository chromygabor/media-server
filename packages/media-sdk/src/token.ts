// A médiaszerver tokenje: Bunny V2 directory-token, IP-kötés nélkül, `kid` és `u` kiegészítéssel
// (terv 4.1; az ellenőrzés sorrendje 4.4). Az algoritmus a Bunny dokumentációját és
// hivatalos aláíró könyvtárát követi (kód átvétele nélkül); a közös vektorok: ../test-vectors.json.
//
//   token        = "HS256-" + Base64URL(HMAC-SHA256(kulcs, token_path + expires + signing_data))
//   signing_data = a paraméterek a token és az expires nélkül, a token_path-szal, kulcs szerint rendezve,
//                  kódolatlan `k=v` párok `&`-rel (nálunk `kid=…&token_path=…[&u=…]`)
//   URL-útvonal  = /bcdn_token=<token>&<rendezett k=encodeURIComponent(v)>&expires=<n><path>
//
// A HMAC kulcsa a kulcs szövege UTF-8 bájtokként, ahogy a Bunny is használja (az `apps.json` base64-szövegét
// nem dekódoljuk). Minden idő unix-másodperc.

import { createHmac } from 'node:crypto';
import { KEY_ID_RE } from './keys.js';
import { classifyMediaPath, isPrefixOf, isSafeMediaPath, isSafeTokenPath, type MediaKind } from './path.js';

const TOKEN_PREFIX = 'HS256-';
/** `HS256-` + 32 bájt Base64URL-ben (43 jel, kitöltés nélkül). */
const TOKEN_RE = /^HS256-[A-Za-z0-9_-]{43}$/;
const EXPIRES_RE = /^(0|[1-9][0-9]{0,11})$/;
/** `kid` és `u`: rövid, URL-biztos azonosító (a `&` és `=` kizárva, így a `signing_data` egyértelmű). */
const ID_RE = KEY_ID_RE;
const SEGMENT_START = '/bcdn_token=';
/** A tokenben engedett paraméterek (a `token` és az `expires` mellett); minden más elutasítva. */
const ALLOWED_PARAMS = ['kid', 'token_path', 'u'] as const;
type ParamName = (typeof ALLOWED_PARAMS)[number];

export interface TokenParams {
  kid: string;
  /** Belső felhasználó-UUID (app-szintű); tartalomtokenben nincs. */
  u?: string;
}

export interface SignTokenInput {
  key: string;
  tokenPath: string;
  expires: number;
  params: TokenParams;
}

export interface BuildSignedPathInput {
  key: string;
  kid: string;
  tokenPath: string;
  expires: number;
  u?: string;
  /** A kért fájl: `/<app>/<assetKey>`. */
  path: string;
}

export interface ParsedSignedPath {
  token: string;
  params: { kid: string; token_path: string; u?: string };
  expires: number;
  path: string;
}

export type ParseError =
  | 'missing-token'
  | 'malformed'
  | 'malformed-token'
  | 'malformed-expires'
  | 'unknown-param'
  | 'duplicate-param'
  | 'missing-param'
  | 'malformed-param';

/** Egy app kulcsai az `apps.json`-ból (terv 4.3): `kid` → kulcs. */
export interface AppKeys {
  keys: Readonly<Record<string, string>>;
  contentKeys: Readonly<Record<string, string>>;
}

export type AppLookup = (app: string) => AppKeys | undefined;

export type VerifyFailureReason =
  | ParseError
  | 'unsafe-path'
  | 'not-servable'
  | 'unknown-app'
  | 'unknown-kid'
  | 'wrong-key-kind'
  | 'bad-signature'
  | 'token-path-app'
  | 'token-path-shape'
  | 'u-not-allowed'
  | 'outside-token-path'
  | 'expired';

export type VerifyResult =
  | {
      ok: true;
      app: string;
      kid: string;
      u: string | undefined;
      path: string;
      assetKey: string;
      kind: MediaKind;
      contentType: string;
    }
  | { ok: false; status: 403 | 404 | 410; reason: VerifyFailureReason };

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Base64URL kitöltés nélkül (`+`→`-`, `/`→`_`, a záró `=` elhagyva). */
export function base64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Időállandó összehasonlítás (azonos hosszra): a különbség az első eltérő jeltől függetlenül derül ki. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function assertSignInput(key: string, tokenPath: string, expires: number, params: TokenParams): void {
  if (typeof key !== 'string' || key === '') throw new RangeError('media-sdk: üres kulcs');
  if (typeof tokenPath !== 'string' || tokenPath === '') throw new RangeError('media-sdk: üres token_path');
  if (!Number.isSafeInteger(expires) || !EXPIRES_RE.test(String(expires))) {
    throw new RangeError(`media-sdk: érvénytelen expires: ${expires}`);
  }
  if (!ID_RE.test(params.kid)) throw new RangeError(`media-sdk: érvénytelen kid: ${JSON.stringify(params.kid)}`);
  if (params.u !== undefined && !ID_RE.test(params.u)) {
    throw new RangeError(`media-sdk: érvénytelen u: ${JSON.stringify(params.u)}`);
  }
}

/** A rendezett paraméterlista (a `token_path`-szal); `u` csak ha van. */
function sortedParams(tokenPath: string, params: TokenParams): Array<[ParamName, string]> {
  const entries: Array<[ParamName, string]> = [
    ['kid', params.kid],
    ['token_path', tokenPath],
  ];
  if (params.u !== undefined) entries.push(['u', params.u]);
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function computeToken(key: string, tokenPath: string, expires: string, params: TokenParams): string {
  const signingData = sortedParams(tokenPath, params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const digest = createHmac('sha256', key).update(tokenPath + expires + signingData, 'utf8').digest();
  return TOKEN_PREFIX + base64url(digest);
}

/** A token (`HS256-…`); csak aláír, az útvonal-szabályokat nem nézi (azokat a `buildSignedPath`). */
export function signToken(input: SignTokenInput): string {
  assertSignInput(input.key, input.tokenPath, input.expires, input.params);
  return computeToken(input.key, input.tokenPath, String(input.expires), input.params);
}

/**
 * Aláírt útvonal: `/bcdn_token=<t>&kid=…&token_path=<kódolt>[&u=…]&expires=<n><path>`.
 * Csak a médiaszerver által elfogadható linket ír alá: biztonságos, kiszolgálható útvonal; böngészős
 * kulcsnál `/`-re végződő könyvtár-`token_path`, tartalomnál pontosan a fájl és `u` nélkül.
 */
export function buildSignedPath(input: BuildSignedPathInput): string {
  const { key, kid, tokenPath, expires, u, path } = input;
  const params: TokenParams = u === undefined ? { kid } : { kid, u };
  assertSignInput(key, tokenPath, expires, params);
  const info = classifyMediaPath(path);
  if (!info) throw new RangeError(`media-sdk: nem kiszolgálható útvonal: ${JSON.stringify(path)}`);
  const problem = tokenPathProblem(tokenPath, path, info.app, info.kind, u);
  if (problem) throw new RangeError(`media-sdk: hibás token_path (${problem}): ${JSON.stringify(tokenPath)}`);
  const token = computeToken(key, tokenPath, String(expires), params);
  const urlData = sortedParams(tokenPath, params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${SEGMENT_START}${token}&${urlData}&expires=${expires}${path}`;
}

/**
 * A nyers kérés-URI (nginx `$request_uri`) szigorú szétszedése; a query (`?…`) levágva.
 * Csak a `kid`, `token_path`, `u` paraméter engedett, mindegyik legfeljebb egyszer, kanonikus
 * `encodeURIComponent`-kódolással; a `kid` és a `token_path` kötelező.
 */
export function parseSignedPath(rawRequestUri: string): ParsedSignedPath | { error: ParseError } {
  const q = rawRequestUri.indexOf('?');
  const uri = q === -1 ? rawRequestUri : rawRequestUri.slice(0, q);
  if (!uri.startsWith(SEGMENT_START)) return { error: 'missing-token' };
  const slash = uri.indexOf('/', 1);
  if (slash === -1) return { error: 'malformed' };
  const parts = uri.slice(1, slash).split('&');
  const path = uri.slice(slash);
  if (parts.length < 2) return { error: 'malformed' };

  const token = (parts[0] as string).slice('bcdn_token='.length);
  if (!TOKEN_RE.test(token)) return { error: 'malformed-token' };

  const last = parts[parts.length - 1] as string;
  if (!last.startsWith('expires=')) return { error: 'malformed-expires' };
  const expiresStr = last.slice('expires='.length);
  if (!EXPIRES_RE.test(expiresStr)) return { error: 'malformed-expires' };

  const params: Partial<Record<ParamName, string>> = {};
  for (const part of parts.slice(1, -1)) {
    const eq = part.indexOf('=');
    if (eq <= 0) return { error: 'malformed' };
    const name = part.slice(0, eq);
    const raw = part.slice(eq + 1);
    if (!(ALLOWED_PARAMS as readonly string[]).includes(name)) return { error: 'unknown-param' };
    if (hasOwn(params, name)) return { error: 'duplicate-param' };
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      return { error: 'malformed-param' };
    }
    if (value === '' || encodeURIComponent(value) !== raw) return { error: 'malformed-param' };
    params[name as ParamName] = value;
  }
  const { kid, token_path, u } = params;
  if (kid === undefined || token_path === undefined) return { error: 'missing-param' };
  if (!ID_RE.test(kid) || (u !== undefined && !ID_RE.test(u))) return { error: 'malformed-param' };
  return {
    token,
    params: u === undefined ? { kid, token_path } : { kid, token_path, u },
    expires: Number(expiresStr),
    path,
  };
}

/** A `token_path` szabálya (terv 4.1): app, alak, kulcsfajta; `null`, ha rendben. */
function tokenPathProblem(
  tokenPath: string,
  path: string,
  app: string,
  kind: MediaKind,
  u: string | undefined,
): 'token-path-app' | 'token-path-shape' | 'u-not-allowed' | 'outside-token-path' | null {
  if (!tokenPath.startsWith(`/${app}/`)) return 'token-path-app';
  if (!isSafeTokenPath(tokenPath)) return 'token-path-shape';
  if (kind === 'browser' && !tokenPath.endsWith('/')) return 'token-path-shape';
  if (kind === 'content') {
    if (tokenPath !== path) return 'token-path-shape';
    if (u !== undefined) return 'u-not-allowed';
  }
  if (!isPrefixOf(tokenPath, path)) return 'outside-token-path';
  return null;
}

/** `AppLookup` egy `apps.json`-szerű objektumból (saját mezők, prototípus nélkül). */
export function appLookupFrom(apps: Readonly<Record<string, AppKeys>>): AppLookup {
  return (app) => (hasOwn(apps, app) ? apps[app] : undefined);
}

function keyOf(map: Readonly<Record<string, string>> | undefined, kid: string): string | undefined {
  if (!map || !hasOwn(map, kid)) return undefined;
  const key = map[kid];
  return typeof key === 'string' && key !== '' ? key : undefined;
}

/**
 * Ellenőrzés a terv 4.4 sorrendjében: alak (`403`) → kiterjesztés-tábla (`404`) → app → `kid` →
 * kulcsfajta → HMAC (időállandó) → `token_path` → lejárat (`410`, csak hiteles tokenre).
 * A fájl létezését (`404`) a hívó (nginx) nézi. `now` unix-másodperc; lejárt, ha `now > expires`.
 */
export function verifySignedPath(rawRequestUri: string, lookupApp: AppLookup, now: number): VerifyResult {
  const parsed = parseSignedPath(rawRequestUri);
  if ('error' in parsed) return { ok: false, status: 403, reason: parsed.error };
  const { token, params, expires, path } = parsed;
  if (!isSafeMediaPath(path)) return { ok: false, status: 403, reason: 'unsafe-path' };
  const info = classifyMediaPath(path);
  if (!info) return { ok: false, status: 404, reason: 'not-servable' };

  const appKeys = lookupApp(info.app);
  if (!appKeys) return { ok: false, status: 403, reason: 'unknown-app' };
  const browserKey = keyOf(appKeys.keys, params.kid);
  const contentKey = keyOf(appKeys.contentKeys, params.kid);
  const key = info.kind === 'content' ? contentKey : browserKey;
  if (key === undefined) {
    const other = info.kind === 'content' ? browserKey : contentKey;
    return { ok: false, status: 403, reason: other === undefined ? 'unknown-kid' : 'wrong-key-kind' };
  }

  const tokenParams: TokenParams = params.u === undefined ? { kid: params.kid } : { kid: params.kid, u: params.u };
  const expected = computeToken(key, params.token_path, String(expires), tokenParams);
  if (!timingSafeEqualStr(expected, token)) return { ok: false, status: 403, reason: 'bad-signature' };

  const problem = tokenPathProblem(params.token_path, path, info.app, info.kind, params.u);
  if (problem) return { ok: false, status: 403, reason: problem };
  if (now > expires) return { ok: false, status: 410, reason: 'expired' };

  return {
    ok: true,
    app: info.app,
    kid: params.kid,
    u: params.u,
    path,
    assetKey: info.assetKey,
    kind: info.kind,
    contentType: info.contentType,
  };
}
