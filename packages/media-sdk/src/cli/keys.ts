// media-keys – új kulcs egy apphoz (SPEC 6.; csomagterv WP33).
//
//   media-keys <app> [--content] [--kid <id>] [--write <apps.json>] [--dir <könyvtár>]
//
// A kulcs 32 véletlen bájt base64url-szövege (43 jel), lásd `generateKey`. Kiírja az apps.json-részletet és a
// backend-oldali értéket (SPEC 9.); fájlt csak `--write`-ra ír, és akkor is csak hozzáad (meglévő kid-et nem ír
// felül). Alapértelmezett apps.json-útvonal nincs: a `--write` útvonala a munkakönyvtárhoz képest értendő.

import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { addKey, defaultKid, generateKey, validateAppsFile } from '../apps-config.js';
import { cliArgs, readAppsFile, writeAppsFile } from './apps-file.js';

export const KEYS_USAGE =
  'Használat: media-keys <app> [--content] [--kid <id>] [--write <apps.json>] [--dir <könyvtár>]';

const KEYS_HELP = `${KEYS_USAGE}

Új kulcs (32 véletlen bájt, base64url) egy apphoz. Kiírja az apps.json-részletet és a backend env-értékeit.
  --content           tartalomkulcs (contentKeys), különben böngészős (keys)
  --kid <id>          a kulcs azonosítója (alapból <év>a, tartalomnál <év>c)
  --write <apps.json> hozzáadja a fájlhoz (nem létezőt 0600-zal hoz létre; meglévő kid-et nem ír felül)
  --dir <könyvtár>    új app dir-je (alapból az app neve)
  -h, --help          ez a súgó

A kulcs titok: ne kerüljön repóba, chatbe, naplóba.`;

export function keysMain(argv: readonly string[]): void {
  const { values, positionals } = parseArgs({
    args: cliArgs(argv),
    allowPositionals: true,
    options: {
      content: { type: 'boolean', default: false },
      kid: { type: 'string' },
      write: { type: 'string' },
      dir: { type: 'string' },
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
  const kid = values.kid ?? defaultKid(content);
  const key = generateKey();
  const field = content ? 'contentKeys' : 'keys';

  if (values.write !== undefined) {
    const file = values.write;
    const apps = addKey(existsSync(file) ? readAppsFile(file) : {}, { app, kid, key, content, dir: values.dir });
    writeAppsFile(file, apps);
    console.log(`Hozzáadva: ${file} → ${app}.${field}.${kid}`);
    const checked = validateAppsFile(apps);
    if (!checked.ok) {
      console.error(
        `Figyelem: a(z) ${file} tartalmilag hibás, a szerver így minden kérésre 403 apps-invalid-ot adna:\n  ${checked.errors.join('\n  ')}`,
      );
    }
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
