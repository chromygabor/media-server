// sign – próbalink aláírása egy apps.json kulcsával (terv 4.1–4.3; implementációs terv WP2).
//
//   pnpm media-server:sign <app> <assetKey> [--content] [--ttl <mp>] [--kid <id>] [--u <uuid>]
//                          [--prefix <token_path>] [--apps <apps.json>] [--base <url>]
//
// Alapból: secrets/apps.local.json, http://127.0.0.1:10090, böngészős kulcs (az app első kid-je), a token_path
// a fájl könyvtára, a lejárat vödrözött 6 óra (bucketExpires). --content: tartalomkulcs, fájlra szóló
// token_path, u nélkül, 5 perc. A kimenet a teljes URL.

import { parseArgs } from 'node:util';
import { bucketExpires, buildSignedPath } from '@chromygabor/media-sdk';
import { cliArgs, isMain, readAppsFile, type AppsFile } from './apps-file.js';

export const DEFAULT_APPS = 'secrets/apps.local.json';
export const DEFAULT_BASE = 'http://127.0.0.1:10090';
export const CONTENT_TTL = 5 * 60;

export interface SignInput {
  apps: AppsFile;
  app: string;
  assetKey: string;
  content?: boolean;
  ttl?: number;
  kid?: string;
  u?: string;
  prefix?: string;
  base?: string;
  now?: number;
}

export function signUrl(input: SignInput): string {
  const { apps, app, assetKey } = input;
  const content = input.content === true;
  const entry = Object.prototype.hasOwnProperty.call(apps, app) ? apps[app] : undefined;
  if (!entry) throw new Error(`nincs ilyen app az apps.json-ban: ${app}`);
  const map = (content ? entry.contentKeys : entry.keys) ?? {};
  const kid = input.kid ?? Object.keys(map)[0];
  if (kid === undefined) throw new Error(`a(z) ${app} appnak nincs ${content ? 'tartalom' : 'böngészős'} kulcsa`);
  const key = Object.prototype.hasOwnProperty.call(map, kid) ? map[kid] : undefined;
  if (key === undefined) throw new Error(`a(z) ${app} appnál nincs ilyen ${content ? 'contentKeys' : 'keys'} kid: ${kid}`);
  if (content && input.u !== undefined) throw new Error('tartalomtokenben nincs u');

  const path = `/${app}/${assetKey.replace(/^\/+/, '')}`;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const expires =
    input.ttl !== undefined ? now + input.ttl : content ? now + CONTENT_TTL : bucketExpires(now);
  const tokenPath = input.prefix ?? (content ? path : path.slice(0, path.lastIndexOf('/') + 1));
  const signed = buildSignedPath({ key, kid, tokenPath, expires, u: input.u, path });
  return `${(input.base ?? DEFAULT_BASE).replace(/\/+$/, '')}${signed}`;
}

function main(): void {
  const { values, positionals } = parseArgs({
    args: cliArgs(),
    allowPositionals: true,
    options: {
      content: { type: 'boolean', default: false },
      ttl: { type: 'string' },
      kid: { type: 'string' },
      u: { type: 'string' },
      prefix: { type: 'string' },
      apps: { type: 'string', default: DEFAULT_APPS },
      base: { type: 'string', default: DEFAULT_BASE },
    },
  });
  const [app, assetKey] = positionals;
  if (positionals.length !== 2 || app === undefined || assetKey === undefined) {
    console.error(
      'Használat: sign <app> <assetKey> [--content] [--ttl <mp>] [--kid <id>] [--u <uuid>] [--prefix <token_path>] [--apps <apps.json>] [--base <url>]',
    );
    process.exit(2);
  }
  let ttl: number | undefined;
  if (values.ttl !== undefined) {
    ttl = Number(values.ttl);
    if (!Number.isInteger(ttl)) throw new Error(`érvénytelen --ttl: ${values.ttl}`);
  }
  console.log(
    signUrl({
      apps: readAppsFile(values.apps ?? DEFAULT_APPS),
      app,
      assetKey,
      content: values.content === true,
      ttl,
      kid: values.kid,
      u: values.u,
      prefix: values.prefix,
      base: values.base,
    }),
  );
}

if (isMain(import.meta.url)) main();
