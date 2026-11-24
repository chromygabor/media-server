// Az `apps.json` (SPEC 6.; csomagterv WP33): típusok, validálás és kulcsgenerálás.
// A szabályok a médiaszerver njs `validateApps`-éi (`server/njs/media.js`); az elfogadás/elutasítás és a
// hibák száma azonos (a szerver `test/config.spec.ts`-e a fixture-ön, hibás változatokon és property-teszttel
// ellenőrzi). A hibaüzenet soha nem tartalmaz kulcsot: a kulcsnak látszó szöveget (`isValidKey`) nem idézi.
// Az ES256 séma (SPEC 2., 6.): `publicKeys`/`contentPublicKeys`, kulcspár-generálás és a nyilvános kulcs felvétele.

import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { importPublicKey, isValidKey, isValidKeyId, isValidPublicKey, parsePrivateKey, rawPublicKey } from './keys.js';
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
  /** ES256 böngészős nyilvános kulcsok: `kid` → tömörítetlen P-256 pont base64url-ben (elhagyható; SPEC 6.). */
  publicKeys?: Record<string, string>;
  /** ES256 tartalom-nyilvános kulcsok (elhagyható); a négy `kid`-halmaz appon belül páronként diszjunkt. */
  contentPublicKeys?: Record<string, string>;
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
 * (lehet üres), a `kid` `isValidKeyId`, a kulcs `isValidKey`; `publicKeys` és `contentPublicKeys` elhagyható, különben
 * objektum, a `kid` `isValidKeyId`, az érték `isValidPublicKey`, és ugyanaz a nyilvános kulcs nem lehet mindkettőben;
 * a négy térkép `kid`-halmaza appon belül páronként diszjunkt; `origins` elhagyható, különben `http(s)://host[:port]`
 * szövegek tömbje; `corp` elhagyható, különben `APP_CORP_VALUES` egyike. A hibák sorrendje és száma az njs-ével azonos
 * (a nyilvános kulcsok szabályait az njs a szerveroldali bekötéssel kapja meg), a szövegük közel azonos, de kulcsot
 * sosem idéz: a kulcsnak látszó app-nevet, kid-et és origint sorszámmal (`#1`) jelöli. A görbén-rajta-létet nem nézi
 * (`checkPublicKeys`).
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
    const browserPublic = new Set<string>();
    for (const field of ['keys', 'contentKeys', 'publicKeys', 'contentPublicKeys'] as const) {
      const map = a[field];
      const isPublic = field === 'publicKeys' || field === 'contentPublicKeys';
      if (isPublic && map === undefined) continue;
      if (!isPlainObject(map)) {
        errors.push(`${at}.${field}: nem objektum`);
        continue;
      }
      Object.keys(map).forEach((kid, k) => {
        const kidText = show(kid, `#${k + 1}`);
        if (!isValidKeyId(kid)) errors.push(`${at}.${field}: érvénytelen kid: ${kidText}`);
        if (!isPublic && !isValidKey(map[kid])) {
          errors.push(`${at}.${field}[${kidText}]: a kulcs nem legalább 43 jeles base64(url) szöveg`);
        }
        if (isPublic && !isValidPublicKey(map[kid])) {
          errors.push(`${at}.${field}[${kidText}]: a nyilvános kulcs nem 87 jeles, tömörítetlen P-256 pont (base64url)`);
        }
        if (field === 'publicKeys' && typeof map[kid] === 'string') browserPublic.add(map[kid]);
        if (field === 'contentPublicKeys' && browserPublic.has(map[kid] as string)) {
          errors.push(`${at}.${field}[${kidText}]: ugyanez a nyilvános kulcs a publicKeys-ben is szerepel`);
        }
        if (kids.has(kid)) errors.push(`${at}: a kid több kulcstérképben is szerepel: ${kidText}`);
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

/**
 * Alap kid, UTC év szerint: HMAC-ra `<év>a` (böngészős) / `<év>c` (tartalom), ES256-ra (`asymmetric`) `<év>e` /
 * `<év>f`.
 */
export function defaultKid(content: boolean, now = new Date(), asymmetric = false): string {
  const suffix = asymmetric ? (content ? 'f' : 'e') : content ? 'c' : 'a';
  return `${now.getUTCFullYear()}${suffix}`;
}

/** Egy ES256 kulcspár: a titkos kulcs az appnál marad, a nyilvános kulcs megy az `apps.json`-ba. */
export interface KeyPair {
  /** PKCS#8 DER base64url. Titok: ne kerüljön repóba, naplóba, hibaüzenetbe; az appot nem hagyja el. */
  privateKey: string;
  /** A tömörítetlen P-256 pont base64url-ben (`PUBLIC_KEY_RE`, 87 jel). Nem titok. */
  publicKey: string;
}

/** Új ES256 kulcspár (P-256, `node:crypto`). */
export function generateKeyPair(): KeyPair {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey: rawPublicKey(privateKey),
  };
}

/** A titkos kulcshoz (PKCS#8 base64url vagy `KeyObject`) tartozó nyilvános kulcs; hibánál `RangeError` idézet nélkül. */
export function publicKeyOf(privateKey: string | KeyObject): string {
  return rawPublicKey(parsePrivateKey(privateKey));
}

/**
 * A nyilvános kulcsok görbe-ellenőrzése (a `validateAppsFile` csak az alakot nézi): minden `publicKeys` /
 * `contentPublicKeys` érték egy P-256 görbén lévő pont-e. A hibák listája (üres, ha rendben); kulcsot nem idéz.
 */
export function checkPublicKeys(apps: AppsFile): string[] {
  const errors: string[] = [];
  Object.keys(apps).forEach((name, i) => {
    const entry: unknown = apps[name];
    if (!isPlainObject(entry)) return;
    const at = `apps[${isValidKey(name) ? `#${i + 1}` : JSON.stringify(name)}]`;
    for (const field of ['publicKeys', 'contentPublicKeys'] as const) {
      const map = entry[field];
      if (!isPlainObject(map)) continue;
      Object.keys(map).forEach((kid, k) => {
        const value = map[kid];
        if (typeof value !== 'string' || importPublicKey(value) === undefined) {
          errors.push(`${at}.${field}[${show(kid, `#${k + 1}`)}]: a nyilvános kulcs nem egy P-256 görbepont`);
        }
      });
    }
  });
  return errors;
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
  if (hasKid(entry, kid)) {
    throw new Error(`a(z) ${app} appnál a(z) ${kid} kid már létezik (felülírás nincs; válassz új kid-et)`);
  }
  if (content) contentKeys[kid] = key;
  else keys[kid] = key;
  return { ...apps, [app]: { ...entry, keys, contentKeys } };
}

/** Szerepel-e a `kid` az app bármelyik kulcstérképében (a négy halmaz diszjunkt). */
function hasKid(entry: AppEntry, kid: string): boolean {
  return [entry.keys, entry.contentKeys, entry.publicKeys, entry.contentPublicKeys].some((m) => isPlainObject(m) && hasOwn(m, kid));
}

export interface AddPublicKeyInput {
  app: string;
  kid: string;
  /** A tömörítetlen P-256 pont base64url-ben (`PUBLIC_KEY_RE`). */
  publicKey: string;
  /** `true`: tartalomkulcs (`contentPublicKeys`), különben böngészős (`publicKeys`). */
  content: boolean;
  /** Új app `dir`-je; alapból az app neve. Meglévő appnál nem számít. */
  dir?: string;
}

/**
 * Egy ES256 nyilvános kulcs felvétele (új objektum, a bemenet nem változik; az üzemeltető `media-keys --register`-e).
 * Új app az `addKey` alapértékeivel. Hiba, ha az app-név vagy a kid érvénytelen, a kulcs alakja vagy görbéje hibás, a
 * kid már szerepel az appnál (bármelyik térképben: felülírás nincs), vagy ugyanez a nyilvános kulcs már szerepel az
 * appnál.
 */
export function addPublicKey(apps: AppsFile, input: AddPublicKeyInput): AppsFile {
  const { app, kid, publicKey, content } = input;
  if (!isValidAppName(app)) throw new Error(`érvénytelen app-név: ${app}`);
  if (!isValidKeyId(kid)) throw new Error(`érvénytelen kid: ${kid}`);
  if (!isValidPublicKey(publicKey) || importPublicKey(publicKey) === undefined) {
    throw new Error('érvénytelen nyilvános kulcs (87 jeles, tömörítetlen P-256 pont base64url-ben kell)');
  }
  const current = hasOwn(apps, app) ? apps[app] : undefined;
  const entry: AppEntry = current ?? { dir: input.dir ?? app, keys: {}, contentKeys: {}, origins: [], corp: 'same-site' };
  if (hasKid(entry, kid)) {
    throw new Error(`a(z) ${app} appnál a(z) ${kid} kid már létezik (felülírás nincs; válassz új kid-et)`);
  }
  const existing = [entry.publicKeys, entry.contentPublicKeys].flatMap((m) => (isPlainObject(m) ? Object.values(m) : []));
  if (existing.includes(publicKey)) throw new Error(`a(z) ${app} appnál ez a nyilvános kulcs már szerepel`);
  const field = content ? 'contentPublicKeys' : 'publicKeys';
  return { ...apps, [app]: { ...entry, [field]: { ...entry[field], [kid]: publicKey } } };
}
