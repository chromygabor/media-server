// Az URL-aláíró (SPEC 1.–3.; csomagterv WP34): egy app backendje egy hívással kap aláírt
// URL-eket egy hatókör-könyvtár fájljaira (böngészős token), illetve egy tartalomkiadásra (tartalom-token).
// Naplózás nincs: ami nem írható alá, az ok-kódként (`SignRefusal`) jön vissza; a naplósort a hívó adapterje írja.
// Két séma (SPEC 2.): `key` → HS256 (determinisztikus), `privateKey` → ES256 (véletlenszerű aláírás). Az ES256-nál az
// aláírás-memó tartja meg, hogy egy munkamenet alatt ugyanaz a link bájtra azonos legyen (a böngésző-cache az URL-re
// szól; aszimmetrikus terv D113, WP51).

import type { KeyObject } from 'node:crypto';
import { parsePrivateKey } from './keys.js';
import { CONTENT_DIR, CONTENT_FILE_EXT, classifyMediaPath, isSafeMediaPath, isSafeSegment, isSafeTokenPath } from './path.js';
import { buildSignedPathWith, type SigningKey, type TokenMemo } from './token.js';

/** A `?v=` hossza: a `sha256` első ennyi hexa jele (gyorsítótár-ürítés újrakódolás után; a szerver a query-t nem nézi). */
export const MEDIA_URL_VERSION_LENGTH = 12;

/** A tartalom-token élettartama alapból (másodperc, ~5 perc). */
export const CONTENT_TOKEN_TTL_SECONDS = 300;

/** Az aláírás-memó legnagyobb mérete (bejegyzés; D113): a határon előbb a lejártak, majd a legrégebbiek esnek ki. */
export const SIGNATURE_MEMO_MAX_ENTRIES = 10_000;

/**
 * Miért nem készült URL:
 * - `reserved`: az `assetKey` első szegmense `_`-os (pl. `_content/…`; böngészős tokent oda nem írunk alá);
 * - `out-of-scope`: az `assetKey` nem a `scopeDir`-en belül van;
 * - `unsafe`: az útvonal nem biztonságos (SPEC 2.1: `..`, `.`-os szegmens, üres szegmens, tiltott jel), illetve
 *   `signContentFile`-nál a verzió nem ad biztonságos fájlnevet, vagy az `app` nem biztonságos szegmens;
 * - `unsupported-type`: a kiterjesztés nincs a szerver böngészős táblájában (SPEC 3.);
 * - `bad-scope`: a `scopeDir` hibás (nincs záró `/`, `_`-os, vagy a `token_path` nem biztonságos), vagy az `app` nem
 *   egyetlen biztonságos szegmens; ilyenkor a hívás minden eleme ezt kapja;
 * - `rejected`: az útvonal rendben, de az aláíró a többi bemenetet elutasította (`kid`, kulcs, `userId`, lejárat;
 *   a `buildSignedPath` `RangeError`-ja, amelynek üzenetét nem adjuk tovább, mert a bemenetet idézi).
 */
export type SignRefusal = 'reserved' | 'out-of-scope' | 'unsafe' | 'unsupported-type' | 'bad-scope' | 'rejected';

export type SignResult = { url: string } | { error: SignRefusal };

export interface UrlSignerConfig {
  /** A médiaszerver bázis-URL-je, záró `/` nélkül (változatlanul elé kerül az aláírt útvonalnak). */
  baseUrl: string;
  /** Az útvonal első szegmense, a szerver `apps.json`-jának kulcsa. */
  app: string;
  /**
   * Böngészős kulcs és a link felső korlátja (másodperc): a `signDirectory`-hoz kell. A `kid` mellé pontosan az egyik:
   * `key` (HMAC, `apps.json` `keys`, `HS256-`) vagy `privateKey` (ES256 titkos kulcs, PKCS#8 DER base64url vagy
   * `KeyObject`; a nyilvános párja az `apps.json` `publicKeys`-ében, `ES256-`). Mindkettő: `TypeError`.
   */
  kid?: string;
  key?: string;
  privateKey?: string | KeyObject;
  maxTtlSeconds?: number;
  /**
   * Tartalomkulcs és a tartalom-token élettartama: a `signContentFile`-hoz kell. A `contentKid` mellé pontosan az
   * egyik: `contentKey` (HMAC, `contentKeys`) vagy `contentPrivateKey` (ES256, `contentPublicKeys`).
   */
  contentKid?: string;
  contentKey?: string;
  contentPrivateKey?: string | KeyObject;
  /** Alapból `CONTENT_TOKEN_TTL_SECONDS` (300). */
  contentTtlSeconds?: number;
  /** Az óra, Unix-ezredmásodperc (alapból `Date.now`); lefelé kerekítve másodpercre. */
  now?: () => number;
}

export interface SignDirectoryInput {
  /** A hatókör-könyvtár az app alatt, `/`-re végződik (pl. `t/lessons/ch-01-l01/`): ez a böngészős `token_path`. */
  scopeDir: string;
  /** A `u` paraméter (a token felhasználóhoz kötése). */
  userId: string;
  /** A felhasználói munkamenet lejárata (Unix-másodperc); `null`/hiányzó: csak a `maxTtlSeconds` korlát. */
  tokenExp?: number | null | undefined;
  assets: readonly SignAsset[];
}

export interface SignAsset {
  /** Az app utáni útvonal (`<scopeDir>…/<fájl>.<ext>`). */
  assetKey: string;
  /** Ha van: `?v=<első 12 jel>` kerül az URL végére (az aláírásnak nem része). */
  sha256?: string | undefined;
}

export interface SignDirectoryOutput {
  /** Az összes kiadott URL közös lejárata: `min(tokenExp, most + maxTtlSeconds)`. */
  expiresAt: Date;
  /** Az `assets` sorrendjében. */
  results: SignResult[];
}

export interface UrlSigner {
  /**
   * Egy könyvtár-token a hatókörre (`token_path = /<app>/<scopeDir>`, `u = userId`, `kid`); minden fájl ugyanazt a
   * tokent kapja, csak az útvonal más. Lejárat: `expires = min(tokenExp, most + maxTtlSeconds)`, `tokenExp` nélkül
   * `most + maxTtlSeconds`; alsó korlát és vödrözés nincs, így egy munkamenet alatt az URL bájtra azonos, ha a
   * munkamenet nem él tovább a korlátnál. ES256-tal az azonosságot az aláírás-memó adja (ugyanarra az aláírt
   * szövegre a korábbi token, amíg le nem jár, és ki nem szorul; `SIGNATURE_MEMO_MAX_ENTRIES`).
   */
  signDirectory(input: SignDirectoryInput): SignDirectoryOutput;
  /**
   * A `/<app>/_content/<version>.json.gz` kiadásfájl URL-je tartalomkulccsal: fájlra szóló `token_path`, `u` nélkül,
   * `expires = most + contentTtlSeconds`.
   */
  signContentFile(version: string): { url: string; expiresAt: Date } | { error: SignRefusal };
}

export function createUrlSigner(config: UrlSignerConfig): UrlSigner {
  const { baseUrl, app } = config;
  // Az app egyetlen biztonságos szegmens (egy `a/b` app különben az `a` app alá írna alá); ha nem az, minden hívás
  // ok-kódot ad (`bad-scope`, illetve `unsafe`), nem dob.
  const appOk = isSafeSegment(app);
  const now = config.now ?? Date.now;
  const nowSeconds = () => Math.floor(now() / 1000);
  const browserKey = signingKeyOf(config.key, config.privateKey, 'key', 'privateKey');
  const contentKey = signingKeyOf(config.contentKey, config.contentPrivateKey, 'contentKey', 'contentPrivateKey');
  const memo = new SignatureMemo(nowSeconds);

  return {
    signDirectory({ scopeDir, userId, tokenExp, assets }) {
      const { kid, maxTtlSeconds } = config;
      if (kid === undefined || browserKey === undefined || maxTtlSeconds === undefined) {
        throw new TypeError('media-sdk: a signDirectory-hoz kid, key (vagy privateKey) és maxTtlSeconds kell');
      }
      const cap = nowSeconds() + maxTtlSeconds;
      const expires = tokenExp === null || tokenExp === undefined ? cap : Math.min(tokenExp, cap);
      const expiresAt = new Date(expires * 1000);
      const tokenPath = `/${app}/${scopeDir}`;
      if (!appOk || !scopeDir.endsWith('/') || scopeDir.startsWith('_') || !isSafeTokenPath(tokenPath)) {
        return { expiresAt, results: assets.map(() => ({ error: 'bad-scope' })) };
      }
      const tokenMemo = memo.for(kid, browserKey, expires);
      const results = assets.map((asset): SignResult => {
        const path = `/${app}/${asset.assetKey}`;
        const problem = browserRefusal(asset.assetKey, scopeDir, path);
        if (problem !== null) return { error: problem };
        let signedPath: string;
        try {
          signedPath = buildSignedPathWith({ ...browserKey, kid, tokenPath, expires, u: userId, path }, tokenMemo);
        } catch {
          return { error: 'rejected' };
        }
        const version = asset.sha256 === undefined ? '' : `?v=${asset.sha256.slice(0, MEDIA_URL_VERSION_LENGTH)}`;
        return { url: `${baseUrl}${signedPath}${version}` };
      });
      return { expiresAt, results };
    },

    signContentFile(version) {
      const { contentKid } = config;
      if (contentKid === undefined || contentKey === undefined) {
        throw new TypeError('media-sdk: a signContentFile-hoz contentKid és contentKey (vagy contentPrivateKey) kell');
      }
      const file = `${version}${CONTENT_FILE_EXT}`;
      const path = `/${app}/${CONTENT_DIR}/${file}`;
      if (!appOk || !isSafeSegment(file) || !isSafeMediaPath(path)) return { error: 'unsafe' };
      if (classifyMediaPath(path)?.kind !== 'content') return { error: 'unsupported-type' };
      const expires = nowSeconds() + (config.contentTtlSeconds ?? CONTENT_TOKEN_TTL_SECONDS);
      let signedPath: string;
      try {
        const tokenMemo = memo.for(contentKid, contentKey, expires);
        signedPath = buildSignedPathWith({ ...contentKey, kid: contentKid, tokenPath: path, expires, path }, tokenMemo);
      } catch {
        return { error: 'rejected' };
      }
      return { url: `${baseUrl}${signedPath}`, expiresAt: new Date(expires * 1000) };
    },
  };
}

/**
 * A konfiguráció egyik kulcsfajtája `SigningKey`-ként; `undefined`, ha nincs megadva. Mindkettő: `TypeError`. A titkos
 * kulcs szövegét egyszer, itt dolgozza fel; ha hibás, a szöveg marad, és minden aláírás `rejected` (a hiba nem idéz).
 */
function signingKeyOf(
  key: string | undefined,
  privateKey: string | KeyObject | undefined,
  keyName: string,
  privateName: string,
): SigningKey | undefined {
  if (key !== undefined && privateKey !== undefined) {
    throw new TypeError(`media-sdk: a ${keyName} és a ${privateName} közül csak az egyik adható meg`);
  }
  if (key !== undefined) return { key };
  if (privateKey === undefined) return undefined;
  try {
    return { privateKey: parsePrivateKey(privateKey) };
  } catch {
    return { privateKey };
  }
}

/**
 * Az aláírás-memó (D113): `kid` + aláírt szöveg (`M`) → token, lejárattal. Csak ES256-ra (a HMAC determinisztikus).
 * Legfeljebb `SIGNATURE_MEMO_MAX_ENTRIES` bejegyzés: a határon előbb a lejártak esnek ki (legfeljebb másodpercenként
 * egy söprés), majd a legrégebbi beszúrás. Lejárt bejegyzést nem ad vissza.
 */
class SignatureMemo {
  private readonly entries = new Map<string, { token: string; expires: number }>();
  private lastSweep = -1;

  constructor(private readonly nowSeconds: () => number) {}

  /** A `buildSignedPathWith` memója egy `kid`-re és lejáratra; HMAC-kulcsra `undefined` (nincs memó). */
  for(kid: string, key: SigningKey, expires: number): TokenMemo | undefined {
    if (key.privateKey === undefined) return undefined;
    return (message, sign) => {
      const memoKey = `${kid}\n${message}`;
      const now = this.nowSeconds();
      const hit = this.entries.get(memoKey);
      if (hit !== undefined && hit.expires >= now) return hit.token;
      if (hit !== undefined) this.entries.delete(memoKey);
      const token = sign();
      this.makeRoom(now);
      this.entries.set(memoKey, { token, expires });
      return token;
    };
  }

  private makeRoom(now: number): void {
    if (this.entries.size < SIGNATURE_MEMO_MAX_ENTRIES) return;
    if (this.lastSweep !== now) {
      this.lastSweep = now;
      for (const [k, e] of this.entries) if (e.expires < now) this.entries.delete(k);
    }
    for (const k of this.entries.keys()) {
      if (this.entries.size < SIGNATURE_MEMO_MAX_ENTRIES) break;
      this.entries.delete(k);
    }
  }
}

/** A böngészős szűrés sorrendje: `_`-os, hatókörön kívüli, nem biztonságos, táblán kívüli; `null`, ha aláírható. */
function browserRefusal(assetKey: string, scopeDir: string, path: string): SignRefusal | null {
  if (assetKey.startsWith('_')) return 'reserved';
  if (!assetKey.startsWith(scopeDir)) return 'out-of-scope';
  if (!isSafeMediaPath(path)) return 'unsafe';
  if (classifyMediaPath(path)?.kind !== 'browser') return 'unsupported-type';
  return null;
}
