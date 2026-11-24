// media-keys – kulcs egy apphoz (SPEC 6.; csomagterv WP33, az ES256 módok:
// aszimmetrikus terv WP51).
//
//   media-keys <app> [--content] [--kid <id>] [--write <apps.json>] [--dir <könyvtár>]          (HMAC, üzemeltető)
//   media-keys --keypair <app> [--content] [--kid <id>]                                         (ES256, app)
//   media-keys --register <app> --kid <id> --public-key <87 jel> [--content] --write <apps.json> [--dir <könyvtár>]
//                                                                                                (ES256, üzemeltető)
//
// HMAC: a kulcs 32 véletlen bájt base64url-szövege (43 jel), lásd `generateKey`. Kiírja az apps.json-részletet és a
// backend-oldali értéket (SPEC 9.); fájlt csak `--write`-ra ír, és akkor is csak hozzáad (meglévő kid-et nem ír
// felül). Alapértelmezett apps.json-útvonal nincs: a `--write` útvonala a munkakönyvtárhoz képest értendő.
// `--keypair`: az app saját ES256 kulcspárja; kiírja a backend env-sorait (titok) és külön az üzemeltetőnek küldendő
// sort (nyilvános kulcs). Fájlt nem ír. `--register`: az üzemeltető felveszi a nyilvános kulcsot (`addPublicKey`:
// kid-ütközésre hiba, felülírás soha), majd a `validateAppsFile` és a `checkPublicKeys` figyelmeztet.

import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  addKey,
  addPublicKey,
  checkPublicKeys,
  defaultKid,
  generateKey,
  generateKeyPair,
  validateAppsFile,
  type AppsFile,
} from '../apps-config.js';
import { cliArgs, readAppsFile, writeAppsFile } from './apps-file.js';

export const KEYS_USAGE = [
  'Használat: media-keys <app> [--content] [--kid <id>] [--write <apps.json>] [--dir <könyvtár>]',
  '           media-keys --keypair <app> [--content] [--kid <id>]',
  '           media-keys --register <app> --kid <id> --public-key <kulcs> [--content] --write <apps.json> [--dir <könyvtár>]',
].join('\n');

const KEYS_HELP = `${KEYS_USAGE}

HMAC (HS256, alapmód; üzemeltetői eszköz): új kulcs (32 véletlen bájt, base64url) egy apphoz. Kiírja az
apps.json-részletet és a backend env-értékeit.
  --content           tartalomkulcs (contentKeys), különben böngészős (keys)
  --kid <id>          a kulcs azonosítója (alapból <év>a, tartalomnál <év>c)
  --write <apps.json> hozzáadja a fájlhoz (nem létezőt 0600-zal hoz létre; meglévő kid-et nem ír felül)
  --dir <könyvtár>    új app dir-je (alapból az app neve)

ES256 (aszimmetrikus; az app saját kulcspárja, a szerver csak a nyilvános kulcsot kapja):
  --keypair           (app) új P-256 kulcspár: a backend env-sorai (titok) és az üzemeltetőnek küldendő sor
                      (nyilvános kulcs); alap kid <év>e, tartalomnál <év>f; fájlt nem ír
  --register          (üzemeltető) a kapott nyilvános kulcs felvétele (publicKeys / contentPublicKeys); a --kid,
                      a --public-key és a --write kötelező; meglévő kid-et nem ír felül
  --public-key <k>    a nyilvános kulcs (87 jel, tömörítetlen P-256 pont base64url-ben)
  -h, --help          ez a súgó

A titkos kulcs (HMAC-kulcs, ES256 titkos kulcs) titok: ne kerüljön repóba, chatbe, naplóba.`;

export function keysMain(argv: readonly string[]): void {
  const { values, positionals } = parseArgs({
    args: cliArgs(argv),
    allowPositionals: true,
    options: {
      content: { type: 'boolean', default: false },
      kid: { type: 'string' },
      write: { type: 'string' },
      dir: { type: 'string' },
      keypair: { type: 'boolean', default: false },
      register: { type: 'boolean', default: false },
      'public-key': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help === true) {
    console.log(KEYS_HELP);
    return;
  }
  const app = positionals[0];
  if (positionals.length !== 1 || app === undefined) {
    console.error(KEYS_USAGE);
    process.exitCode = 2;
    return;
  }
  const content = values.content === true;
  if (values.keypair === true && values.register === true) throw new Error('a --keypair és a --register kizárja egymást');
  if (values.keypair !== true && values.register !== true && values['public-key'] !== undefined) {
    throw new Error('a --public-key csak a --register-rel adható meg');
  }
  if (values.keypair === true) {
    if (values.write !== undefined || values.dir !== undefined || values['public-key'] !== undefined) {
      throw new Error('a --keypair fájlt nem ír: a --write, a --dir és a --public-key nem adható meg');
    }
    keypair(app, content, values.kid ?? defaultKid(content, new Date(), true));
    return;
  }
  if (values.register === true) {
    const { kid, write: file } = values;
    const publicKey = values['public-key'];
    if (kid === undefined || publicKey === undefined || file === undefined) {
      throw new Error('a --register-hez a --kid, a --public-key és a --write kötelező');
    }
    register(file, { app, kid, publicKey, content, dir: values.dir });
    return;
  }
  hmac(app, content, values.kid ?? defaultKid(content), values.write, values.dir);
}

/** HMAC (alapmód): új kulcs, opcionálisan a fájlba írva. */
function hmac(app: string, content: boolean, kid: string, file: string | undefined, dir: string | undefined): void {
  const key = generateKey();
  const field = content ? 'contentKeys' : 'keys';

  if (file !== undefined) {
    const apps = addKey(existsSync(file) ? readAppsFile(file) : {}, { app, kid, key, content, dir });
    writeAppsFile(file, apps);
    console.log(`Hozzáadva: ${file} → ${app}.${field}.${kid}`);
    warnIfInvalid(file, apps);
  } else {
    addKey({}, { app, kid, key, content }); // csak az app-név / kid ellenőrzése
  }

  console.log(`\napps.json (${app}.${field}):\n  ${JSON.stringify({ [kid]: key })}`);
  console.log('\nBackend (javasolt env-nevek, SPEC 9.):');
  if (content) {
    console.log(`  MEDIA_SERVER_CONTENT_KEY_ID=${kid}\n  MEDIA_SERVER_CONTENT_KEY=${key}`);
  } else {
    console.log(`  MEDIA_SERVER_KEY_ID=${kid}\n  MEDIA_SERVER_KEYS=${JSON.stringify({ [kid]: key })}`);
  }
  console.log('\nA kulcs titok: ne kerüljön repóba, chatbe, naplóba.');
}

/** `--keypair` (app oldal): új ES256 kulcspár; a titkos kulcs csak a stdout-ra kerül, fájlba nem. */
function keypair(app: string, content: boolean, kid: string): void {
  const { privateKey, publicKey } = generateKeyPair();
  addPublicKey({}, { app, kid, publicKey, content }); // csak az app-név / kid / kulcs ellenőrzése
  const kind = content ? 'tartalom' : 'böngészős';
  console.log('Backend env (titok: csak az app saját env-jébe, SPEC 9.):');
  if (content) {
    console.log(`  MEDIA_SERVER_CONTENT_KEY_ID=${kid}\n  MEDIA_SERVER_CONTENT_PRIVATE_KEY=${privateKey}`);
  } else {
    console.log(`  MEDIA_SERVER_KEY_ID=${kid}\n  MEDIA_SERVER_PRIVATE_KEYS=${JSON.stringify({ [kid]: privateKey })}`);
  }
  console.log('\nAz üzemeltetőnek küldendő (nem titok):');
  console.log(`  app=${app} kid=${kid} fajta=${kind} publicKey=${publicKey}`);
  console.log(`  Ellenőrző jelek (második csatornán egyeztetendő): ${publicKey.slice(0, 8)} … ${publicKey.slice(-8)}`);
  console.log(
    `  Az üzemeltető parancsa: media-keys --register ${app} --kid ${kid} --public-key ${publicKey}${content ? ' --content' : ''} --write <apps.json>`,
  );
  console.log('\nA titkos kulcs titok: ne kerüljön repóba, chatbe, naplóba; az appot nem hagyja el.');
}

/** `--register` (üzemeltető): a nyilvános kulcs felvétele; kid-ütközésnél hiba, a fájl nem változik. */
function register(file: string, input: { app: string; kid: string; publicKey: string; content: boolean; dir: string | undefined }): void {
  const apps = addPublicKey(existsSync(file) ? readAppsFile(file) : {}, input);
  writeAppsFile(file, apps);
  const field = input.content ? 'contentPublicKeys' : 'publicKeys';
  console.log(`Hozzáadva: ${file} → ${input.app}.${field}.${input.kid} (${input.publicKey.slice(0, 8)} … ${input.publicKey.slice(-8)})`);
  warnIfInvalid(file, apps);
}

/** Figyelmeztetés, ha a kiírt fájl tartalmilag hibás (alak vagy görbe); kulcsot nem idéz. */
function warnIfInvalid(file: string, apps: AppsFile): void {
  const checked = validateAppsFile(apps);
  if (!checked.ok) {
    console.error(
      `Figyelem: a(z) ${file} tartalmilag hibás, a szerver így minden kérésre 403 apps-invalid-ot adna:\n  ${checked.errors.join('\n  ')}`,
    );
    return;
  }
  const curve = checkPublicKeys(apps);
  if (curve.length > 0) {
    console.error(`Figyelem: a(z) ${file} hibás nyilvános kulcsot tartalmaz (a kid-jére a szerver 403-at adna):\n  ${curve.join('\n  ')}`);
  }
}
