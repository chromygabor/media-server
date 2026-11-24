// A `media-keys` parancs belépési pontja (a logika: `../cli/keys.ts`).
import { keysMain } from '../cli/keys.js';
import { run } from '../cli/apps-file.js';

run('media-keys', () => keysMain(process.argv.slice(2)));
