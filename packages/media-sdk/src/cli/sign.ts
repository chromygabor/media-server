// media-sign – próbalink aláírása egy apps.json kulcsával (SPEC 1.–3., 6.;
// csomagterv WP33).
//
//   media-sign --apps <apps.json> <app> <assetKey> [--content] [--ttl <mp>] [--kid <id>] [--u <uuid>]
//              [--prefix <token_path>] [--base <url>]
//
// Az `--apps` kötelező (alapértelmezett útvonal nincs; többszöri megadásnál az utolsó számít). Alapból:
// http://127.0.0.1:10090, böngészős kulcs (az app első kid-je), a token_path a fájl könyvtára, a lejárat vödrözött
// 6 óra (bucketExpires). --content: tartalomkulcs, fájlra szóló token_path, u nélkül, 5 perc. A kimenet a teljes URL.

import { parseArgs } from 'node:util';
import type { AppsFile } from '../apps-config.js';
import { bucketExpires } from '../expires.js';
import { CONTENT_TOKEN_TTL_SECONDS } from '../signer.js';
import { buildSignedPath } from '../token.js';
import { cliArgs, readAppsFile } from './apps-file.js';

export const DEFAULT_BASE = 'http://127.0.0.1:10090';
export const CONTENT_TTL = CONTENT_TOKEN_TTL_SECONDS;

export const SIGN_USAGE =
  'Használat: media-sign --apps <apps.json> <app> <assetKey> [--content] [--ttl <mp>] [--kid <id>] [--u <uuid>] [--prefix <token_path>] [--base <url>]';

const SIGN_HELP = `${SIGN_USAGE}

Próbalink aláírása az apps.json egy kulcsával; a kimenet a teljes URL.
  --apps <apps.json>     az apps.json útvonala (kötelező)
  --content              tartalomkulcs, fájlra szóló token_path, u nélkül, 5 perc
  --ttl <mp>             élettartam másodpercben (alapból vödrözött 6 óra)
  --kid <id>             a kulcs azonosítója (alapból az app első kid-je)
  --u <uuid>             a token u paramétere (böngészős)
  --prefix <token_path>  a token_path (alapból a fájl könyvtára)
  --base <url>           a szerver alap-URL-je (alapból ${DEFAULT_BASE})
  -h, --help             ez a súgó`;

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
  const expires = input.ttl !== undefined ? now + input.ttl : content ? now + CONTENT_TTL : bucketExpires(now);
  const tokenPath = input.prefix ?? (content ? path : path.slice(0, path.lastIndexOf('/') + 1));
  const signed = buildSignedPath({ key, kid, tokenPath, expires, u: input.u, path });
  return `${(input.base ?? DEFAULT_BASE).replace(/\/+$/, '')}${signed}`;
}

export function signMain(argv: readonly string[]): void {
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
      base: { type: 'string', default: DEFAULT_BASE },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help === true) {
    console.log(SIGN_HELP);
    return;
  }
  const [app, assetKey] = positionals;
  if (positionals.length !== 2 || app === undefined || assetKey === undefined || values.apps === undefined) {
    console.error(SIGN_USAGE);
    process.exitCode = 2;
    return;
  }
  let ttl: number | undefined;
  if (values.ttl !== undefined) {
    ttl = Number(values.ttl);
    if (!Number.isInteger(ttl)) throw new Error(`érvénytelen --ttl: ${values.ttl}`);
  }
  console.log(
    signUrl({
      apps: readAppsFile(values.apps),
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
