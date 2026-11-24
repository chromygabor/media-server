// Az URL-aláíró (csomagterv WP34; SPEC 1.–3.): egy app backendje egy hívással kap aláírt
// URL-eket egy hatókör-könyvtár fájljaira (böngészős token), illetve egy tartalomkiadásra (tartalom-token).
// Naplózás nincs: ami nem írható alá, az ok-kódként (`SignRefusal`) jön vissza; a naplósort a hívó adapterje írja.

import { CONTENT_DIR, CONTENT_FILE_EXT, classifyMediaPath, isSafeMediaPath, isSafeSegment, isSafeTokenPath } from './path.js';
import { buildSignedPath } from './token.js';

/** A `?v=` hossza: a `sha256` első ennyi hexa jele (gyorsítótár-ürítés újrakódolás után; a szerver a query-t nem nézi). */
export const MEDIA_URL_VERSION_LENGTH = 12;

/** A tartalom-token élettartama alapból (másodperc, ~5 perc). */
export const CONTENT_TOKEN_TTL_SECONDS = 300;

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
  /** Böngészős kulcs (`apps.json` `keys`) és a link felső korlátja (másodperc): a `signDirectory`-hoz kell. */
  kid?: string;
  key?: string;
  maxTtlSeconds?: number;
  /** Tartalomkulcs (`apps.json` `contentKeys`) és a tartalom-token élettartama: a `signContentFile`-hoz kell. */
  contentKid?: string;
  contentKey?: string;
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
   * munkamenet nem él tovább a korlátnál.
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

  return {
    signDirectory({ scopeDir, userId, tokenExp, assets }) {
      const { kid, key, maxTtlSeconds } = config;
      if (kid === undefined || key === undefined || maxTtlSeconds === undefined) {
        throw new TypeError('media-sdk: a signDirectory-hoz kid, key és maxTtlSeconds kell');
      }
      const cap = nowSeconds() + maxTtlSeconds;
      const expires = tokenExp === null || tokenExp === undefined ? cap : Math.min(tokenExp, cap);
      const expiresAt = new Date(expires * 1000);
      const tokenPath = `/${app}/${scopeDir}`;
      if (!appOk || !scopeDir.endsWith('/') || scopeDir.startsWith('_') || !isSafeTokenPath(tokenPath)) {
        return { expiresAt, results: assets.map(() => ({ error: 'bad-scope' })) };
      }
      const results = assets.map((asset): SignResult => {
        const path = `/${app}/${asset.assetKey}`;
        const problem = browserRefusal(asset.assetKey, scopeDir, path);
        if (problem !== null) return { error: problem };
        let signedPath: string;
        try {
          signedPath = buildSignedPath({ key, kid, tokenPath, expires, u: userId, path });
        } catch {
          return { error: 'rejected' };
        }
        const version = asset.sha256 === undefined ? '' : `?v=${asset.sha256.slice(0, MEDIA_URL_VERSION_LENGTH)}`;
        return { url: `${baseUrl}${signedPath}${version}` };
      });
      return { expiresAt, results };
    },

    signContentFile(version) {
      const { contentKid, contentKey } = config;
      if (contentKid === undefined || contentKey === undefined) {
        throw new TypeError('media-sdk: a signContentFile-hoz contentKid és contentKey kell');
      }
      const file = `${version}${CONTENT_FILE_EXT}`;
      const path = `/${app}/${CONTENT_DIR}/${file}`;
      if (!appOk || !isSafeSegment(file) || !isSafeMediaPath(path)) return { error: 'unsafe' };
      if (classifyMediaPath(path)?.kind !== 'content') return { error: 'unsupported-type' };
      const expires = nowSeconds() + (config.contentTtlSeconds ?? CONTENT_TOKEN_TTL_SECONDS);
      let signedPath: string;
      try {
        signedPath = buildSignedPath({ key: contentKey, kid: contentKid, tokenPath: path, expires, path });
      } catch {
        return { error: 'rejected' };
      }
      return { url: `${baseUrl}${signedPath}`, expiresAt: new Date(expires * 1000) };
    },
  };
}

/** A böngészős szűrés sorrendje: `_`-os, hatókörön kívüli, nem biztonságos, táblán kívüli; `null`, ha aláírható. */
function browserRefusal(assetKey: string, scopeDir: string, path: string): SignRefusal | null {
  if (assetKey.startsWith('_')) return 'reserved';
  if (!assetKey.startsWith(scopeDir)) return 'out-of-scope';
  if (!isSafeMediaPath(path)) return 'unsafe';
  if (classifyMediaPath(path)?.kind !== 'browser') return 'unsupported-type';
  return null;
}
