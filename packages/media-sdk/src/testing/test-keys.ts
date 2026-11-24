// CSAK TESZT kulcsok (csomagterv WP35): a közös tesztvektorokból (`test-vectors.json`, amely maga is „CSAK TESZT
// kulcsok”-ként jelöli őket) levezetett teszt-app, böngészős és tartalomkulcs. Éles vagy dev kulcs soha nem kerül ide.
// Közvetlenül adható a `createUrlSigner`-nek és a `startFakeMediaServer`-nek:
//
//   const fake = await startFakeMediaServer({ apps: testKeys.apps, root });
//   const signer = createUrlSigner({ ...testKeys, baseUrl: fake.url, maxTtlSeconds: 3600 });

import type { AppCorp, AppsFile } from '../apps-config.js';
import vectors from '../../test-vectors.json' with { type: 'json' };

/** A tesztkulcsok: a `createUrlSigner` konfigurációjának kulcsrésze és egy hozzá illő, kész `apps.json`. */
export interface TestKeys {
  /** A teszt-app neve (az `apps` egyetlen kulcsa). */
  readonly app: string;
  /** Böngészős kulcs (`keys`). */
  readonly kid: string;
  readonly key: string;
  /** Tartalomkulcs (`contentKeys`). */
  readonly contentKid: string;
  readonly contentKey: string;
  /** `{ [app]: { dir: '.', keys: { [kid]: key }, contentKeys: { [contentKid]: contentKey } } }` */
  readonly apps: AppsFile;
}

/** A `testAppsFile` beállításai; ami hiányzik, az a `testKeys` alapértéke (`dir`: `.`, `origins`/`corp` nincs). */
export interface TestAppsOptions {
  app?: string;
  /** A fájlok helye a hamis szerver `root`-ja alatt (SPEC 6.); alapból `.`: `<root>/<assetKey>`. */
  dir?: string;
  origins?: string[];
  corp?: AppCorp;
}

const browserVector = vectors.sign.find((v) => v.tokenPath.endsWith('/') && !v.tokenPath.includes('/_content/'));
const contentVector = vectors.sign.find((v) => v.tokenPath.includes('/_content/'));
if (browserVector === undefined || contentVector === undefined) {
  throw new Error('media-sdk: a test-vectors.json-ban nincs böngészős vagy tartalomkulcsos sign vektor');
}

const TEST_APP = 'test-app';

/**
 * Egy appos `apps.json` a tesztkulcsokkal (friss objektum minden hívásra). Más app-névvel, `dir`-rel, `origins`-szel
 * vagy `corp`-pal is kérhető, pl. ha a tesztelt backend saját app-nevet használ.
 */
export function testAppsFile(options: TestAppsOptions = {}): AppsFile {
  const { app = TEST_APP, dir = '.', origins, corp } = options;
  return {
    [app]: {
      dir,
      keys: { [browserVector!.params.kid]: browserVector!.key },
      contentKeys: { [contentVector!.params.kid]: contentVector!.key },
      ...(origins === undefined ? {} : { origins: [...origins] }),
      ...(corp === undefined ? {} : { corp }),
    },
  };
}

/** CSAK TESZT: a közös tesztvektorok böngészős és tartalomkulcsa, a `test-app` appal. */
export const testKeys: TestKeys = Object.freeze({
  app: TEST_APP,
  kid: browserVector.params.kid,
  key: browserVector.key,
  contentKid: contentVector.params.kid,
  contentKey: contentVector.key,
  apps: testAppsFile(),
});
