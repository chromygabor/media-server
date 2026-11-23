// Az apps.json olvasása / írása a CLI-khez (terv 4.3). Írás helyben (ugyanaz az inode, így a futó konténer
// csak olvasható bind mountja is az új tartalmat látja), az eredeti jogosultság megtartásával.

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface AppEntry {
  dir: string;
  keys: Record<string, string>;
  contentKeys: Record<string, string>;
  origins: string[];
  corp: string;
}

export type AppsFile = Record<string, AppEntry>;

export function readAppsFile(file: string): AppsFile {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file}: a gyökér nem objektum`);
  }
  return parsed as AppsFile;
}

/** Új fájl 0600-zal; meglévőnél a jogosultság marad (0400-nál ideiglenesen u+w). */
export function writeAppsFile(file: string, apps: AppsFile): void {
  const text = `${JSON.stringify(apps, null, 2)}\n`;
  if (!existsSync(file)) {
    writeFileSync(file, text, { mode: 0o600 });
    return;
  }
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o200) === 0) chmodSync(file, mode | 0o200);
  try {
    writeFileSync(file, text);
  } finally {
    if ((mode & 0o200) === 0) chmodSync(file, mode);
  }
}

/** Közvetlenül futtatják-e a modult (és nem a teszt importálja). */
export const isMain = (metaUrl: string): boolean =>
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === metaUrl;

/** A parancssori argumentumok; a gyökérszkript (`pnpm … --`) által továbbadott vezető `--` nélkül. */
export function cliArgs(): string[] {
  const args = process.argv.slice(2);
  return args[0] === '--' ? args.slice(1) : args;
}
