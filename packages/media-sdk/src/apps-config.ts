// Az `apps.json` (SPEC 6.; csomagterv WP33): típusok, validálás és kulcsgenerálás.
// A szabályok a médiaszerver njs `validateApps`-éi (`server/njs/media.js`); az elfogadás/elutasítás és a
// hibák száma azonos (a szerver `test/config.spec.ts`-e a fixture-ön, hibás változatokon és property-teszttel
// ellenőrzi). A hibaüzenet soha nem tartalmaz kulcsot: a kulcsnak látszó szöveget (`isValidKey`) nem idézi.

import { randomBytes } from 'node:crypto';
import { isValidKey, isValidKeyId } from './keys.js';
import { isSafeSegment } from './path.js';

/** A `Cross-Origin-Resource-Policy` engedett értékei (SPEC 6.; alapérték `same-site`). */
export const APP_CORP_VALUES = ['same-site', 'same-origin', 'cross-origin'] as const;
export type AppCorp = (typeof APP_CORP_VALUES)[number];

/** Egy app az `apps.json`-ban (SPEC 6.). */
export interface AppEntry {
  /** `.` vagy biztonságos szegmensekből álló relatív út a médiagyökér alatt; több app osztozhat rajta. */
  dir: string;
  /** Böngészős kulcsok: `kid` → kulcs (lehet üres). */
  keys: Record<string, string>;
  /** Tartalomkulcsok: `kid` → kulcs (lehet üres); a `kid`-halmaz diszjunkt a `keys`-étől. */
  contentKeys: Record<string, string>;
  /** CORS: `http(s)://host[:port]` alakú originek (elhagyható). */
  origins?: string[];
  /** Elhagyható; alapból `same-site`. */
  corp?: AppCorp;
}

/** Az `apps.json` gyökere: app-név → bejegyzés. */
export type AppsFile = Record<string, AppEntry>;

/** A `validateAppsFile` eredménye: érvényes fájlnál a (változatlan) bemenet típusosan, különben a hibák listája. */
export type ValidateAppsResult = { ok: true; apps: AppsFile } | { ok: false; errors: string[] };

const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Az app-név: biztonságos szegmens, nem `_`-sal kezdődik (SPEC 6.). */
export function isValidAppName(name: string): boolean {
  return isSafeSegment(name) && !name.startsWith('_');
}

/** `dir`: `.` vagy biztonságos szegmensekből álló relatív útvonal. */
function isSafeDir(dir: string): boolean {
  if (dir === '.') return true;
  if (dir === '') return false;
  return dir.split('/').every(isSafeSegment);
}

/** Idézhető-e egy szöveg a hibaüzenetben: ami kulcsnak látszik, az nem (pl. felcserélt kid és kulcs). */
const show = (s: string, hidden: string): string => (isValidKey(s) ? hidden : s);

/**
 * Az `apps.json` tartalmi ellenőrzése, az njs `validateApps` szabályaival: legalább egy app; az app-név biztonságos
 * szegmens, nem `_`-os; `dir` kötelező (`.` vagy biztonságos relatív út); `keys` és `contentKeys` kötelező objektum
 * (lehet üres), a `kid` `isValidKeyId`, a kulcs `isValidKey`, a két `kid`-halmaz appon belül diszjunkt; `origins`
 * elhagyható, különben `http(s)://host[:port]` szövegek tömbje; `corp` elhagyható, különben `APP_CORP_VALUES` egyike.
 * A hibák sorrendje és száma az njs-ével azonos, a szövegük közel azonos, de kulcsot sosem idéz: a kulcsnak látszó
 * app-nevet, kid-et és origint sorszámmal (`#1`) jelöli. Egy szándékos eltérés: a `__proto__` kid mindkét térképben
 * itt hiba, az njs (sima objektumos halmaz miatt) nem veszi észre.
 */
export function validateAppsFile(value: unknown): ValidateAppsResult {
  if (!isPlainObject(value)) return { ok: false, errors: ['a gyökér nem objektum'] };
  const errors: string[] = [];
  const names = Object.keys(value);
  if (names.length === 0) errors.push('nincs egy app sem');
  names.forEach((name, i) => {
    const a = value[name];
    const at = `apps[${isValidKey(name) ? `#${i + 1}` : JSON.stringify(name)}]`;
    if (!isValidAppName(name)) errors.push(`${at}: érvénytelen app-név`);
    if (!isPlainObject(a)) {
      errors.push(`${at}: nem objektum`);
      return;
    }
    if (typeof a.dir !== 'string' || !isSafeDir(a.dir)) errors.push(`${at}.dir: érvénytelen könyvtár`);
    const kids = new Set<string>();
    for (const field of ['keys', 'contentKeys'] as const) {
      const map = a[field];
      if (!isPlainObject(map)) {
        errors.push(`${at}.${field}: nem objektum`);
        continue;
      }
      Object.keys(map).forEach((kid, k) => {
        const kidText = show(kid, `#${k + 1}`);
        if (!isValidKeyId(kid)) errors.push(`${at}.${field}: érvénytelen kid: ${kidText}`);
        if (!isValidKey(map[kid])) {
          errors.push(`${at}.${field}[${kidText}]: a kulcs nem legalább 43 jeles base64(url) szöveg`);
        }
        if (kids.has(kid)) errors.push(`${at}: a kid a keys-ben és a contentKeys-ben is szerepel: ${kidText}`);
        kids.add(kid);
      });
    }
    if (a.origins !== undefined) {
      if (!Array.isArray(a.origins)) errors.push(`${at}.origins: nem tömb`);
      else {
        (a.origins as unknown[]).forEach((orig, o) => {
          if (typeof orig !== 'string' || !ORIGIN_RE.test(orig)) {
            errors.push(`${at}.origins: érvénytelen origin: ${show(String(orig), `#${o + 1}`)}`);
          }
        });
      }
    }
    if (a.corp !== undefined && !(APP_CORP_VALUES as readonly unknown[]).includes(a.corp)) {
      errors.push(`${at}.corp: érvénytelen érték`);
    }
  });
  return errors.length === 0 ? { ok: true, apps: value as AppsFile } : { ok: false, errors };
}

/**
 * Új kulcs: 32 véletlen bájt base64url-szövege (43 jel). A HMAC kulcsa ez a SZÖVEG UTF-8-ként (Bunny-szerint), nem a
 * dekódolt bájtok (SPEC 6.). A kulcs titok: ne kerüljön repóba, naplóba, hibaüzenetbe.
 */
export function generateKey(): string {
  return randomBytes(32).toString('base64url');
}

/** Alap kid: `<év>a` (böngészős) / `<év>c` (tartalom), UTC év szerint. */
export function defaultKid(content: boolean, now = new Date()): string {
  return `${now.getUTCFullYear()}${content ? 'c' : 'a'}`;
}

export interface AddKeyInput {
  app: string;
  kid: string;
  key: string;
  /** `true`: tartalomkulcs (`contentKeys`), különben böngészős (`keys`). */
  content: boolean;
  /** Új app `dir`-je; alapból az app neve. Meglévő appnál nem számít. */
  dir?: string;
}

/**
 * A kulcs hozzáadása (új objektum, a bemenet nem változik). Új app: `dir` = `input.dir ?? app`, üres kulcstérképek,
 * `origins: []`, `corp: 'same-site'`. Hiba, ha az app-név vagy a kid érvénytelen, vagy a kid már szerepel az appnál
 * (bármelyik kulcsfajtában): felülírás nincs. A kulcs alakját nem nézi; a hibaüzenet a kulcsot nem idézi.
 */
export function addKey(apps: AppsFile, input: AddKeyInput): AppsFile {
  const { app, kid, key, content } = input;
  if (!isValidAppName(app)) throw new Error(`érvénytelen app-név: ${app}`);
  if (!isValidKeyId(kid)) throw new Error(`érvénytelen kid: ${kid}`);
  const current = hasOwn(apps, app) ? apps[app] : undefined;
  const entry: AppEntry = current ?? { dir: input.dir ?? app, keys: {}, contentKeys: {}, origins: [], corp: 'same-site' };
  const keys = { ...entry.keys };
  const contentKeys = { ...entry.contentKeys };
  if (hasOwn(keys, kid) || hasOwn(contentKeys, kid)) {
    throw new Error(`a(z) ${app} appnál a(z) ${kid} kid már létezik (felülírás nincs; válassz új kid-et)`);
  }
  if (content) contentKeys[kid] = key;
  else keys[kid] = key;
  return { ...apps, [app]: { ...entry, keys, contentKeys } };
}
