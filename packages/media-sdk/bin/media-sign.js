#!/usr/bin/env node
// A `media-sign` parancs: a buildelt belépési pont (`dist/bin/media-sign.js`, forrás: `src/bin/media-sign.ts`). A wrapper azért
// van a `dist/`-en kívül, hogy a monorepóban a `pnpm install` build előtt is be tudja kötni a parancsot.
import '../dist/bin/media-sign.js';
