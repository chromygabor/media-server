import { defineConfig } from 'tsup';

export default defineConfig([
  // A könyvtár: `.`, `./apps-config` és `./testing`, ESM + CJS, típusokkal.
  {
    entry: { index: 'src/index.ts', 'apps-config': 'src/apps-config.ts', testing: 'src/testing/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  // A parancsok: egy-egy önálló ESM-fájl (a csomag `type: module`); a `bin` mező a `bin/` alatti wrapperre mutat, amely
  // ezeket importálja (a wrapper a build előtt is létezik, így a `pnpm install` mindig bekötheti a parancsot).
  {
    entry: { 'media-keys': 'src/bin/media-keys.ts', 'media-sign': 'src/bin/media-sign.ts' },
    outDir: 'dist/bin',
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: false,
    splitting: false,
  },
]);
