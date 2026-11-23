import { defineConfig } from 'vitest/config';

// A sima `pnpm test` docker nélkül fut; a docker-integrációs teszt (WP3) külön konfiggal, a test/docker/ alatt.
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    exclude: ['test/docker/**', 'node_modules/**'],
  },
});
