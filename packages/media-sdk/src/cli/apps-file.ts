// Az apps.json olvasása / írása a CLI-khez (SPEC 6.). Írás helyben (ugyanaz az inode, így a futó konténer csak
// olvasható bind mountja is az új tartalmat látja), az eredeti jogosultság megtartásával. A hibaüzenet soha nem
// tartalmazza a fájl szövegét (benne kulcsok vannak).

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AppsFile } from '../apps-config.js';

/** A `JSON.parse` hibájából csak a pozíció (sor, oszlop) – a V8 üzenete a bemenetből is idéz, azt nem adjuk tovább. */
function jsonErrorPosition(text: string, error: unknown): string {
  const m = error instanceof Error ? /\bposition (\d+)\b/.exec(error.message) : null;
  if (!m) return '';
  const pos = Math.min(Number(m[1]), text.length);
  const before = text.slice(0, pos).split('\n');
  return ` (${before.length}. sor, ${(before.at(-1) ?? '').length + 1}. oszlop)`;
}

/** Az apps.json beolvasása; tartalmilag nem ellenőriz (`validateAppsFile`), csak hogy JSON-objektum. */
export function readAppsFile(file: string): AppsFile {
  const text = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: az apps.json nem érvényes JSON${jsonErrorPosition(text, error)}`);
  }
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

/**
 * A parancssori argumentumok az első `--` nélkül: a `pnpm <szkript> -- …` továbbadja, és egy gyökérszkript előtte
 * saját argumentumot is adhat (pl. `--apps …`), így nem csak az elején lehet. Kötőjeles pozicionális argumentum
 * (app-név, assetKey) nincs, ezért a `--` itt nem kell elválasztónak.
 */
export function cliArgs(argv: readonly string[]): string[] {
  const i = argv.indexOf('--');
  return i === -1 ? [...argv] : [...argv.slice(0, i), ...argv.slice(i + 1)];
}

/** A CLI-k közös futtatója: hibánál egy sor a stderr-re (a parancs nevével, verem nélkül) és 1-es kilépési kód. */
export function run(name: string, main: () => void): void {
  try {
    main();
  } catch (error) {
    console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
