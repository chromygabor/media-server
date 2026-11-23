// keys:new – új kulcs egy apphoz (terv 4.3; implementációs terv WP2).
//
//   pnpm media-server:keys <app> [--content] [--kid <id>] [--write <apps.json>] [--dir <könyvtár>]
//
// A kulcs 32 véletlen bájt base64url-szövege (43 jel). A HMAC kulcsa ez a SZÖVEG UTF-8-ként (Bunny-szerint),
// nem a dekódolt bájtok. Kiírja az apps.json-részletet és a backend-oldali (MS2) értéket; fájlt csak
// `--write`-ra ír, és akkor is csak hozzáad (meglévő kid-et nem ír felül).

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { cliArgs, isMain, readAppsFile, writeAppsFile, type AppsFile } from './apps-file.js';

const SAFE_SEGMENT = /^[A-Za-z0-9-][A-Za-z0-9._-]*$/;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function generateKey(): string {
  return randomBytes(32).toString('base64url');
}

/** Alap kid: `<év>a` (böngészős) / `<év>c` (tartalom), terv 4.3. */
export function defaultKid(content: boolean, now = new Date()): string {
  return `${now.getUTCFullYear()}${content ? 'c' : 'a'}`;
}

export interface AddKeyInput {
  app: string;
  kid: string;
  key: string;
  content: boolean;
  dir?: string;
}

/** A kulcs hozzáadása (új objektum); hiba, ha a kid már szerepel az appnál (bármelyik kulcsfajtában). */
export function addKey(apps: AppsFile, input: AddKeyInput): AppsFile {
  const { app, kid, key, content } = input;
  if (!SAFE_SEGMENT.test(app)) throw new Error(`érvénytelen app-név: ${app}`);
  if (!ID_RE.test(kid)) throw new Error(`érvénytelen kid: ${kid}`);
  const current = Object.prototype.hasOwnProperty.call(apps, app) ? apps[app] : undefined;
  const entry = current ?? { dir: input.dir ?? app, keys: {}, contentKeys: {}, origins: [], corp: 'same-site' };
  const keys = { ...entry.keys };
  const contentKeys = { ...entry.contentKeys };
  if (Object.prototype.hasOwnProperty.call(keys, kid) || Object.prototype.hasOwnProperty.call(contentKeys, kid)) {
    throw new Error(`a(z) ${app} appnál a(z) ${kid} kid már létezik (felülírás nincs; válassz új kid-et)`);
  }
  if (content) contentKeys[kid] = key;
  else keys[kid] = key;
  return { ...apps, [app]: { ...entry, keys, contentKeys } };
}

function main(): void {
  const { values, positionals } = parseArgs({
    args: cliArgs(),
    allowPositionals: true,
    options: {
      content: { type: 'boolean', default: false },
      kid: { type: 'string' },
      write: { type: 'string' },
      dir: { type: 'string' },
    },
  });
  const app = positionals[0];
  if (positionals.length !== 1 || app === undefined) {
    console.error('Használat: keys:new <app> [--content] [--kid <id>] [--write <apps.json>] [--dir <könyvtár>]');
    process.exit(2);
  }
  const content = values.content === true;
  const kid = values.kid ?? defaultKid(content);
  const key = generateKey();
  const field = content ? 'contentKeys' : 'keys';

  if (values.write !== undefined) {
    const file = values.write;
    const apps = existsSync(file) ? readAppsFile(file) : {};
    writeAppsFile(file, addKey(apps, { app, kid, key, content, dir: values.dir }));
    console.log(`Hozzáadva: ${file} → ${app}.${field}.${kid}`);
  } else {
    addKey({}, { app, kid, key, content }); // csak az app-név / kid ellenőrzése
  }

  console.log(`\napps.json (${app}.${field}):\n  ${JSON.stringify({ [kid]: key })}`);
  console.log('\nBackend (MS2, javasolt env-nevek, terv 4.3):');
  if (content) {
    console.log(`  MEDIA_SERVER_CONTENT_KEY_ID=${kid}\n  MEDIA_SERVER_CONTENT_KEY=${key}`);
  } else {
    console.log(`  MEDIA_SERVER_KEY_ID=${kid}\n  MEDIA_SERVER_KEYS=${JSON.stringify({ [kid]: key })}`);
  }
  console.log('\nA kulcs titok: ne kerüljön repóba, chatbe, naplóba.');
}

if (isMain(import.meta.url)) main();
