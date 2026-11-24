// media-sign – próbalink aláírása (SPEC 1.–3., 6., 9.; csomagterv WP33, az `--env`
// mód: aszimmetrikus terv WP51, D117).
//
//   media-sign --apps <apps.json> <app> <assetKey> [--content] [--ttl <mp>] [--kid <id>] [--u <uuid>]
//              [--prefix <token_path>] [--base <url>]                                         (üzemeltető, HMAC)
//   media-sign --env | --env-file <.env> <assetKey> [ugyanezek a kapcsolók]                (app, HMAC vagy ES256)
//
// `--apps`: az apps.json HMAC-kulcsával (alapértelmezett útvonal nincs; többszöri megadásnál az utolsó számít). Egy
// ES256 (`publicKeys`/`contentPublicKeys`) kid-hez az üzemeltető nem tud aláírni: az app írja alá, `--env`-vel.
// `--env` (a folyamat környezete) / `--env-file` (egy dotenv-fájl, csak annak változói; a folyamat környezetét nem
// módosítja): a SPEC 9. nevei, apps.json nélkül; a séma a kid helyéből jön (`MEDIA_SERVER_KEYS` → HS256,
// `MEDIA_SERVER_PRIVATE_KEYS` → ES256). A kulcs soha nem kerül a kimenetbe vagy a hibaüzenetbe.
// Alapból: http://127.0.0.1:10090 (`--env`-nél a `MEDIA_SERVER_URL`), böngészős kulcs, a token_path a fájl könyvtára,
// a lejárat vödrözött 6 óra (bucketExpires). --content: tartalomkulcs, fájlra szóló token_path, u nélkül, 5 perc. A
// kimenet a teljes URL.

import { readFileSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import type { AppsFile } from '../apps-config.js';
import { bucketExpires } from '../expires.js';
import { isValidPrivateKey } from '../keys.js';
import { CONTENT_TOKEN_TTL_SECONDS } from '../signer.js';
import { buildSignedPath, type SigningKey } from '../token.js';
import { cliArgs, readAppsFile } from './apps-file.js';

export const DEFAULT_BASE = 'http://127.0.0.1:10090';
export const CONTENT_TTL = CONTENT_TOKEN_TTL_SECONDS;

export const SIGN_USAGE = [
  'Használat: media-sign --apps <apps.json> <app> <assetKey> [--content] [--ttl <mp>] [--kid <id>] [--u <uuid>] [--prefix <token_path>] [--base <url>]',
  '           media-sign --env | --env-file <.env> <assetKey> [--content] [--ttl <mp>] [--kid <id>] [--u <uuid>] [--prefix <token_path>] [--base <url>]',
].join('\n');

const SIGN_HELP = `${SIGN_USAGE}

Próbalink aláírása; a kimenet a teljes URL.
  --apps <apps.json>     az apps.json HMAC-kulcsával (üzemeltető)
  --env                  a folyamat környezetéből (app; SPEC 9.): MEDIA_SERVER_APP, MEDIA_SERVER_URL,
                         MEDIA_SERVER_KEY_ID + MEDIA_SERVER_KEYS (HMAC) vagy MEDIA_SERVER_PRIVATE_KEYS (ES256),
                         tartalomhoz MEDIA_SERVER_CONTENT_KEY_ID + MEDIA_SERVER_CONTENT_KEY vagy
                         MEDIA_SERVER_CONTENT_PRIVATE_KEY
  --env-file <.env>      ugyanez egy dotenv-fájlból (csak a fájl változói)
  --content              tartalomkulcs, fájlra szóló token_path, u nélkül, 5 perc
  --ttl <mp>             élettartam másodpercben (alapból vödrözött 6 óra)
  --kid <id>             a kulcs azonosítója (alapból: --apps-nál az app első kid-je, --env-nél a *_KEY_ID)
  --u <uuid>             a token u paramétere (böngészős)
  --prefix <token_path>  a token_path (alapból a fájl könyvtára)
  --base <url>           a szerver alap-URL-je (alapból --env-nél a MEDIA_SERVER_URL, különben ${DEFAULT_BASE})
  -h, --help             ez a súgó`;

interface SignOptions {
  app: string;
  assetKey: string;
  content?: boolean;
  ttl?: number;
  u?: string;
  prefix?: string;
  base?: string;
  now?: number;
}

/**
 * A `signUrl` bemenete: az apps.json-ból (`apps`, a kid alapból az app első HMAC-kid-je), vagy közvetlenül egy kid és
 * a kulcsa (`key` HMAC, `privateKey` ES256). Az apps.json-ág az utóbbira vezet vissza.
 */
export type SignInput = SignOptions & ({ apps: AppsFile; kid?: string } | (SigningKey & { kid: string; apps?: undefined }));

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Az apps.json HMAC-kulcsa a kid-hez; az ES256 kid-re érthető hiba (az üzemeltető nem tud aláírni). */
function keyFromApps(apps: AppsFile, app: string, content: boolean, wanted: string | undefined): { kid: string; key: string } {
  const entry = hasOwn(apps, app) ? apps[app] : undefined;
  if (!entry) throw new Error(`nincs ilyen app az apps.json-ban: ${app}`);
  const map = (content ? entry.contentKeys : entry.keys) ?? {};
  const publicMap = (content ? entry.contentPublicKeys : entry.publicKeys) ?? {};
  const asymmetric = (kid: string) =>
    new Error(`aszimmetrikus kid (${kid}, ${content ? 'contentPublicKeys' : 'publicKeys'}): az app írja alá, --env`);
  const kid = wanted ?? Object.keys(map)[0];
  if (kid === undefined) {
    const first = Object.keys(publicMap)[0];
    if (first !== undefined) throw asymmetric(first);
    throw new Error(`a(z) ${app} appnak nincs ${content ? 'tartalom' : 'böngészős'} kulcsa`);
  }
  if (hasOwn(map, kid)) return { kid, key: map[kid] as string };
  if (hasOwn(publicMap, kid)) throw asymmetric(kid);
  throw new Error(`a(z) ${app} appnál nincs ilyen ${content ? 'contentKeys' : 'keys'} kid: ${kid}`);
}

export function signUrl(input: SignInput): string {
  const { app, assetKey } = input;
  const content = input.content === true;
  const signing: SigningKey & { kid: string } =
    input.apps !== undefined
      ? keyFromApps(input.apps, app, content, input.kid)
      : input.key !== undefined
        ? { kid: input.kid, key: input.key }
        : { kid: input.kid, privateKey: input.privateKey };
  if (content && input.u !== undefined) throw new Error('tartalomtokenben nincs u');

  const path = `/${app}/${assetKey.replace(/^\/+/, '')}`;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const expires = input.ttl !== undefined ? now + input.ttl : content ? now + CONTENT_TTL : bucketExpires(now);
  const tokenPath = input.prefix ?? (content ? path : path.slice(0, path.lastIndexOf('/') + 1));
  const signed = buildSignedPath({ ...signing, tokenPath, expires, u: input.u, path });
  return `${(input.base ?? DEFAULT_BASE).replace(/\/+$/, '')}${signed}`;
}

/** Az `--env` / `--env-file` eredménye: az app, az alap-URL (ha van) és a kid a kulcsával. */
export type EnvSigning = { app: string; base: string | undefined } & SigningKey & { kid: string };

type Env = Readonly<Record<string, string | undefined>>;

/** Egy env-változó (az üres szöveg hiánynak számít). */
function envValue(env: Env, name: string): string | undefined {
  const v = hasOwn(env, name) ? env[name] : undefined;
  return v === undefined || v === '' ? undefined : v;
}

/** Egy JSON-objektum env-változó (`kid` → szöveg); a hibaüzenet az értéket nem idézi. */
function envMap(env: Env, name: string): Record<string, string> | undefined {
  const raw = envValue(env, name);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`a ${name} nem érvényes JSON (kid → kulcs objektum kell)`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.values(parsed).every((v) => typeof v === 'string')) {
    throw new Error(`a ${name} nem kid → kulcs (szöveg) objektum`);
  }
  return parsed as Record<string, string>;
}

function checkedPrivateKey(value: string, where: string): string {
  if (!isValidPrivateKey(value)) throw new Error(`${where}: érvénytelen titkos kulcs (PKCS#8 DER base64url, P-256 kell)`);
  return value;
}

/**
 * A kulcs a SPEC 9. env-neveiből (`--env` / `--env-file`; D117). Böngészős: a kid a `wantedKid` vagy a
 * `MEDIA_SERVER_KEY_ID`, pontosan az egyik térképben (`MEDIA_SERVER_KEYS` → HS256, `MEDIA_SERVER_PRIVATE_KEYS` →
 * ES256). Tartalom: `MEDIA_SERVER_CONTENT_KEY_ID` és a `MEDIA_SERVER_CONTENT_KEY` **vagy** a
 * `MEDIA_SERVER_CONTENT_PRIVATE_KEY`. Hiba esetén a változó nevét mondja, az értékét soha.
 */
export function signingFromEnv(env: Env, content: boolean, wantedKid?: string): EnvSigning {
  const app = envValue(env, 'MEDIA_SERVER_APP');
  if (app === undefined) throw new Error('hiányzik a MEDIA_SERVER_APP');
  const base = envValue(env, 'MEDIA_SERVER_URL');
  if (content) {
    const kid = envValue(env, 'MEDIA_SERVER_CONTENT_KEY_ID');
    if (kid === undefined) throw new Error('hiányzik a MEDIA_SERVER_CONTENT_KEY_ID');
    if (wantedKid !== undefined && wantedKid !== kid) {
      throw new Error('a --kid tartalomnál csak a MEDIA_SERVER_CONTENT_KEY_ID lehet (egy tartalomkulcs van)');
    }
    const key = envValue(env, 'MEDIA_SERVER_CONTENT_KEY');
    const privateKey = envValue(env, 'MEDIA_SERVER_CONTENT_PRIVATE_KEY');
    if (key !== undefined && privateKey !== undefined) {
      throw new Error('a MEDIA_SERVER_CONTENT_KEY és a MEDIA_SERVER_CONTENT_PRIVATE_KEY közül csak az egyik adható meg');
    }
    if (key !== undefined) return { app, base, kid, key };
    if (privateKey !== undefined) return { app, base, kid, privateKey: checkedPrivateKey(privateKey, 'MEDIA_SERVER_CONTENT_PRIVATE_KEY') };
    throw new Error('hiányzik a MEDIA_SERVER_CONTENT_KEY vagy a MEDIA_SERVER_CONTENT_PRIVATE_KEY');
  }
  const kid = wantedKid ?? envValue(env, 'MEDIA_SERVER_KEY_ID');
  if (kid === undefined) throw new Error('hiányzik a MEDIA_SERVER_KEY_ID');
  const keys = envMap(env, 'MEDIA_SERVER_KEYS');
  const privateKeys = envMap(env, 'MEDIA_SERVER_PRIVATE_KEYS');
  if (keys === undefined && privateKeys === undefined) throw new Error('hiányzik a MEDIA_SERVER_KEYS vagy a MEDIA_SERVER_PRIVATE_KEYS');
  const inKeys = keys !== undefined && hasOwn(keys, kid);
  const inPrivate = privateKeys !== undefined && hasOwn(privateKeys, kid);
  if (inKeys && inPrivate) throw new Error(`a(z) ${kid} kid a MEDIA_SERVER_KEYS-ben és a MEDIA_SERVER_PRIVATE_KEYS-ben is szerepel`);
  if (inKeys) return { app, base, kid, key: keys[kid] as string };
  if (inPrivate) return { app, base, kid, privateKey: checkedPrivateKey(privateKeys[kid] as string, `MEDIA_SERVER_PRIVATE_KEYS[${kid}]`) };
  throw new Error(`a(z) ${kid} kid nincs sem a MEDIA_SERVER_KEYS-ben, sem a MEDIA_SERVER_PRIVATE_KEYS-ben`);
}

export function signMain(argv: readonly string[], env: Env = process.env): void {
  const { values, positionals } = parseArgs({
    args: cliArgs(argv),
    allowPositionals: true,
    options: {
      content: { type: 'boolean', default: false },
      ttl: { type: 'string' },
      kid: { type: 'string' },
      u: { type: 'string' },
      prefix: { type: 'string' },
      apps: { type: 'string' },
      env: { type: 'boolean', default: false },
      'env-file': { type: 'string' },
      base: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help === true) {
    console.log(SIGN_HELP);
    return;
  }
  const envMode = values.env === true || values['env-file'] !== undefined;
  if (values.env === true && values['env-file'] !== undefined) throw new Error('a --env és az --env-file kizárja egymást');
  if (envMode && values.apps !== undefined) throw new Error('az --apps és a --env / --env-file kizárja egymást');
  const wanted = envMode ? 1 : 2;
  if (positionals.length !== wanted || (!envMode && values.apps === undefined)) {
    console.error(SIGN_USAGE);
    process.exitCode = 2;
    return;
  }
  let ttl: number | undefined;
  if (values.ttl !== undefined) {
    ttl = Number(values.ttl);
    if (!Number.isInteger(ttl)) throw new Error(`érvénytelen --ttl: ${values.ttl}`);
  }
  const content = values.content === true;
  const common = { content, ttl, u: values.u, prefix: values.prefix };
  if (envMode) {
    const file = values['env-file'];
    const source: Env = file === undefined ? env : parseEnv(readFileSync(file, 'utf8'));
    const { app, base, ...signing } = signingFromEnv(source, content, values.kid);
    console.log(signUrl({ ...common, ...signing, app, assetKey: positionals[0] as string, base: values.base ?? base }));
    return;
  }
  const [app, assetKey] = positionals as [string, string];
  console.log(signUrl({ ...common, apps: readAppsFile(values.apps as string), app, assetKey, kid: values.kid, base: values.base }));
}
