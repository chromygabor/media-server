// `@chromygabor/media-sdk/testing` (csomagterv WP35): hamis médiaszerver és CSAK TESZT kulcsok az appok tesztjeihez.
// Csak tesztkódból importálandó; futásidejű függősége nincs (`node:*`).

export { startFakeMediaServer } from './fake-server.js';
export type {
  FakeMediaFailure,
  FakeMediaOverride,
  FakeMediaOverrideFn,
  FakeMediaRequest,
  FakeMediaRoute,
  FakeMediaServer,
  FakeMediaServerOptions,
} from './fake-server.js';
export { testAppsFile, testKeys } from './test-keys.js';
export type { TestAppsOptions, TestEs256Keys, TestKeys } from './test-keys.js';
