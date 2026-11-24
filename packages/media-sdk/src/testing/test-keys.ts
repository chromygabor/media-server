// CSAK TESZT kulcsok (csomagterv WP35): a közös tesztvektorokból (`test-vectors.json`, amely maga is „CSAK TESZT
// kulcsok”-ként jelöli őket) levezetett teszt-app, böngészős és tartalomkulcs. Éles vagy dev kulcs soha nem kerül ide.
// Közvetlenül adható a `createUrlSigner`-nek és a `startFakeMediaServer`-nek:
//
//   const fake = await startFakeMediaServer({ apps: testKeys.apps, root });
//   const signer = createUrlSigner({ ...testKeys, baseUrl: fake.url, maxTtlSeconds: 3600 });
//
// Az ES256 séma (aszimmetrikus) CSAK TESZT kulcspárjai a `testKeys.es256`-ban (a vektorok `es256` blokkjából); a
// `testAppsFile()` a nyilvános párjukat is felveszi (`publicKeys`, `contentPublicKeys`):
//
//   const signer = createUrlSigner({ app: testKeys.app, ...testKeys.es256, baseUrl: fake.url, maxTtlSeconds: 3600 });

import type { AppCorp, AppsFile } from '../apps-config.js';
import vectors from '../../test-vectors.json' with { type: 'json' };

/** Az ES256 CSAK TESZT kulcspárok: a titkos kulcs a `createUrlSigner`-é, a nyilvános az `apps.json`-é. */
export interface TestEs256Keys {
  /** Böngészős kulcspár (`publicKeys`). */
  readonly kid: string;
  readonly privateKey: string;
  readonly publicKey: string;
  /** Tartalom-kulcspár (`contentPublicKeys`). */
  readonly contentKid: string;
  readonly contentPrivateKey: string;
  readonly contentPublicKey: string;
}

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
  /** ES256 kulcspárok (a `privateKey` / `contentPrivateKey` a `createUrlSigner`-nek, a HMAC-kulcsok helyett). */
  readonly es256: TestEs256Keys;
  /**
   * `{ [app]: { dir: '.', keys: { [kid]: key }, contentKeys: { [contentKid]: contentKey }, publicKeys: { [es256.kid]:
   * es256.publicKey }, contentPublicKeys: { [es256.contentKid]: es256.contentPublicKey } } }`
   */
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
const es = vectors.es256;

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
      publicKeys: { [es.kid]: es.publicKey },
      contentPublicKeys: { [es.contentKid]: es.contentPublicKey },
      ...(origins === undefined ? {} : { origins: [...origins] }),
      ...(corp === undefined ? {} : { corp }),
    },
  };
}

/** Mély fagyasztás: a közös objektumot egy teszt se írhassa át a többi alatt (a tömböket és a belső objektumokat sem). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/**
 * CSAK TESZT: a közös tesztvektorok böngészős és tartalomkulcsa (HS256) és két ES256 kulcspárja, a `test-app` appal. Mélyen fagyasztott (az `apps` és
 * benne a `keys` / `contentKeys` is): módosítani nem lehet (szigorú módban `TypeError`); más `apps.json`-hoz a
 * `testAppsFile()` ad friss, módosítható objektumot.
 */
export const testKeys: TestKeys = deepFreeze({
  app: TEST_APP,
  kid: browserVector.params.kid,
  key: browserVector.key,
  contentKid: contentVector.params.kid,
  contentKey: contentVector.key,
  es256: {
    kid: es.kid,
    privateKey: es.privateKey,
    publicKey: es.publicKey,
    contentKid: es.contentKid,
    contentPrivateKey: es.contentPrivateKey,
    contentPublicKey: es.contentPublicKey,
  },
  apps: testAppsFile(),
});
