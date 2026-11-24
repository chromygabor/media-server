// A `media-sign` parancs belépési pontja (a logika: `../cli/sign.ts`).
import { signMain } from '../cli/sign.js';
import { run } from '../cli/apps-file.js';

run('media-sign', () => signMain(process.argv.slice(2)));
