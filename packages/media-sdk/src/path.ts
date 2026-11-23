// Útvonal-szabályok a médiaszerver tokenjéhez (terv 4.1, 4.4).
// Az útvonal alakja `/<app>/<assetKey>`; minden szegmens `[A-Za-z0-9._-]`, nem kezdődik `.`-tal,
// nem üres. Így `..`, `%`, `//`, záró `/` és rejtett fájl eleve nem fér bele.

/** Egy biztonságos útvonal-szegmens: `[A-Za-z0-9._-]+`, nem `.`-tal kezdődik. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** A böngészős (nem `_`-os) útvonalakon kiszolgálható kiterjesztések (terv 4.4; a backend `MEDIA_CONTENT_TYPES`-ával egyezik). */
export const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg',
};

/** A tartalomkiadás könyvtára az app alatt; csak tartalomkulccsal érhető el (terv 4.3). */
export const CONTENT_DIR = '_content';
/** A tartalomkiadás kiterjesztése és típusa (`Content-Encoding` nélkül, terv 4.4). */
export const CONTENT_FILE_EXT = '.json.gz';
export const CONTENT_FILE_TYPE = 'application/gzip';

export type MediaKind = 'browser' | 'content';

export interface MediaPathInfo {
  /** Az útvonal első szegmense. */
  app: string;
  /** Az app utáni rész (`<topicId>/lessons/…` vagy `_content/<v>.json.gz`). */
  assetKey: string;
  /** Melyik kulcsfajta érvényes rá: böngészős (`keys`) vagy tartalom (`contentKeys`). */
  kind: MediaKind;
  contentType: string;
}

export function isSafeSegment(segment: string): boolean {
  return SAFE_SEGMENT.test(segment);
}

/** `/<app>/<…>/<fájl>`: legalább két szegmens, mindegyik biztonságos (terv 4.1 „Ellenőrzés”). */
export function isSafeMediaPath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  const segments = path.slice(1).split('/');
  return segments.length >= 2 && segments.every(isSafeSegment);
}

/**
 * A `token_path` alakja: `/<app>/…`, biztonságos szegmensekkel; könyvtárnál `/`-re végződik.
 * Csak az alakot nézi, a kulcsfajta szerinti szabályt (`/`-re végződés, pontos fájl) a hívó.
 */
export function isSafeTokenPath(tokenPath: string): boolean {
  if (!tokenPath.startsWith('/')) return false;
  const body = tokenPath.endsWith('/') ? tokenPath.slice(1, -1) : tokenPath.slice(1);
  if (body === '') return false;
  return body.split('/').every(isSafeSegment);
}

/**
 * Előtag-egyezés (terv 4.1, P6): `/`-re végződő `token_path` könyvtár (a `…/ch-01-l0/` nem fedi a
 * `…/ch-01-l01/…`-et), egyébként pontos fájl-egyezés.
 */
export function isPrefixOf(tokenPath: string, path: string): boolean {
  if (tokenPath === '') return false;
  return tokenPath.endsWith('/') ? path.startsWith(tokenPath) : path === tokenPath;
}

/**
 * A kiterjesztés-tábla (terv 4.4): biztonságos útvonalra a kulcsfajta és a `Content-Type`, vagy `null`,
 * ha a fájl nem szolgálható ki (→ `404`). `_`-os az útvonal, ha az app utáni első szegmens `_`-sal kezdődik;
 * ott csak a `/<app>/_content/<fájl>.json.gz` engedett.
 */
export function classifyMediaPath(path: string): MediaPathInfo | null {
  if (!isSafeMediaPath(path)) return null;
  const segments = path.slice(1).split('/');
  const app = segments[0] as string;
  const rest = segments.slice(1);
  const assetKey = rest.join('/');
  const file = rest[rest.length - 1] as string;
  if ((rest[0] as string).startsWith('_')) {
    if (rest[0] === CONTENT_DIR && rest.length === 2 && file.endsWith(CONTENT_FILE_EXT) && file.length > CONTENT_FILE_EXT.length) {
      return { app, assetKey, kind: 'content', contentType: CONTENT_FILE_TYPE };
    }
    return null;
  }
  const dot = file.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = file.slice(dot);
  if (!Object.prototype.hasOwnProperty.call(MEDIA_CONTENT_TYPES, ext)) return null;
  return { app, assetKey, kind: 'browser', contentType: MEDIA_CONTENT_TYPES[ext] as string };
}
