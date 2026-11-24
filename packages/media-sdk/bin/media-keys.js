#!/usr/bin/env node
// A `media-keys` parancs: a buildelt belépési pont (`dist/bin/media-keys.js`, forrás: `src/bin/media-keys.ts`). A wrapper azért
// van a `dist/`-en kívül, hogy a monorepóban a `pnpm install` build előtt is be tudja kötni a parancsot.
import '../dist/bin/media-keys.js';
