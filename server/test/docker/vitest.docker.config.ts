import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// A docker-integrációs teszt (implementációs terv WP3): `pnpm --filter @chromygabor/media-server test:docker`
// (gyökérből: `pnpm test:docker`). A sima `pnpm test` ezt nem futtatja (../../vitest.config.ts).
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['test/docker/**/*.docker.spec.ts'],
    globalSetup: ['test/docker/setup.ts'],
    // Egy konténer, sorban futó esetek (a korlát-tesztek a végén).
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
