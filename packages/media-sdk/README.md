# @chromygabor/media-sdk

A védett médiaszerver (`server/` ebben a repóban) kliensoldala: aláírt URL (Bunny V2 directory-token, IP-kötés nélkül,
`kid` és `u` kiegészítéssel), ellenőrzés, útvonal-szabályok, közös tesztvektorok. Futásidejű függőség nincs
(`node:crypto`).

- **A protokoll normatív leírása: [`SPEC.md`](SPEC.md)** (URL-alak, token, státuszkódok, fejlécek, `apps.json`,
  kulcsforgatás, feltöltés, ajánlott env-nevek). A telepítés üzemeltetői oldala a repó `deploy/README.md`-jében van.
- Tipikus fogyasztók: egy app backendje (URL-aláírás, a tesztjei a `./testing`-gel), a frontend e2e-tesztjei
  (`./testing`) és a médiaszerver saját tesztjei; a szerver repójának gyökerében a `pnpm keys` / `pnpm sign` a csomag
  parancsait hívja.

```
/bcdn_token=HS256-<sig>&kid=<kid>&token_path=<kódolt előtag>[&u=<uuid>]&expires=<unix>/<app>/<assetKey>
/bcdn_token=ES256-<sig>&…   (ugyanaz az alak)

M   = token_path + expires + "kid=…&token_path=…[&u=…]"
sig = Base64URL(HMAC-SHA256(kulcs, M))                       HS256: Bunny-kompatibilis, közös titok
    | Base64URL(r ‖ s), ECDSA P-256 + SHA-256 az M-en, low-S  ES256: az app saját kulcspárja (a szerver csak a
                                                              nyilvános kulcsot ismeri); Bunny-megfelelője nincs
```

A séma a `kid`-ből jön (`keys`/`contentKeys` → HS256, `publicKeys`/`contentPublicKeys` → ES256), soha nem a
tokenből. Mindkettő elsőrangú; egy appnak lehetnek mindkét fajtájú `kid`-jei.

## Telepítés

A csomag nincs npm-regisztryben: minden verzió a `chromygabor/media-server` repó egy GitHub Release-ének melléklete
(tag: `sdk-v<verzió>`, fájl: `chromygabor-media-sdk-<verzió>.tgz`). URL-függőségként telepíthető, token és
regisztry-beállítás nélkül, pnpm-mel és npm-mel egyformán:

```json
"@chromygabor/media-sdk": "https://github.com/chromygabor/media-server/releases/download/sdk-v1.0.0/chromygabor-media-sdk-1.0.0.tgz"
```

```sh
pnpm add https://github.com/chromygabor/media-server/releases/download/sdk-v1.0.0/chromygabor-media-sdk-1.0.0.tgz
npm install https://github.com/chromygabor/media-server/releases/download/sdk-v1.0.0/chromygabor-media-sdk-1.0.0.tgz
```

- **A tarball kész csomag:** benne van a lefordított `dist/`, telepítéskor nincs build és nincs életciklus-szkript
  (`install`, `prepare` stb.); futásidejű függősége nincs.
- **A lockfile rögzíti:** a pnpm és az npm a tarball URL-jét és `sha512-…` integrity-jét írja a lockfile-ba; egy
  később más tartalommal felülírt melléklet telepítése hibát ad.
- **Frissítés:** semver-tartomány (`^1.0.0`) itt nincs; a verziót az URL két helyén kell átírni (`sdk-v<verzió>` és a
  fájlnév), utána `pnpm install` / `npm install`. A változásokat a `CHANGELOG.md` írja le; a semver jelentése
  ugyanaz, mint egy regisztryből jövő csomagnál (major: törő protokoll- vagy felületváltozás).
- **A melléklet pontosan a kipróbált fájl:** a kiadási szkript (`pnpm release:sdk` a repó gyökerében) ugyanazt a
  `.tgz`-t ellenőrzi a `check:standalone`-nal egy üres projektben (ESM, CJS, `./testing`, `bin`), amelyet a Release-be
  feltöltünk; a sha256-ja a Release szövegében áll.

## Gyors kezdés egy új apphoz

Két egyenrangú kulcsmodell, appenként és `kid`-enként választható:

- **ES256 (aszimmetrikus, ajánlott új apphoz):** az app generálja a kulcspárt, az üzemeltetőhöz csak a nyilvános
  kulcs megy. Titok nem halad át a regisztráció csatornáján.

  ```sh
  media-keys --keypair <app> [--content] [--kid <id>]      # app: env-sorok (titok) + az üzemeltetőnek küldendő sor
  media-keys --register <app> --kid <id> --public-key <87 jel> [--content] --write apps.json   # üzemeltető
  media-sign --env-file .env <assetKey> [--u <uuid>] [--content]                                # app: próbalink
  ```

  A backend env-je (SPEC 9.): `MEDIA_SERVER_PRIVATE_KEYS={"<kid>":"<PKCS#8 base64url>"}`, `MEDIA_SERVER_KEY_ID`,
  tartalomhoz `MEDIA_SERVER_CONTENT_KEY_ID` + `MEDIA_SERVER_CONTENT_PRIVATE_KEY`. Az üzemeltető a nyilvános kulcs első
  és utolsó 8 jelét egy második csatornán egyezteti (a `--keypair` kiírja).
- **HMAC (HS256, Bunny-kompatibilis):** az üzemeltető generálja a kulcsot (`media-keys <app>`), és titkosított
  csatornán adja át; a lépések lent.

1. **Kulcs**: `media-keys <app> [--content] [--kid <id>] [--write <apps.json>] [--dir <könyvtár>]` (a szerver repójában
   `pnpm keys …`). Kiírja az `apps.json`-részletet és a backend env-értékeit (SPEC 9.); `--write`-tal
   hozzáadja a fájlhoz (meglévő `kid`-et nem ír felül). A kulcs titok. Próbalink: `media-sign --apps <apps.json>
   <app> <assetKey> [--u <uuid>] [--content] [--base <url>]` (üzemeltető), vagy az app a saját env-jéből:
   `media-sign --env | --env-file <.env> <assetKey>`. Programból: `@chromygabor/media-sdk/apps-config`
   (`generateKey`, `addKey`, `generateKeyPair`, `addPublicKey`, `validateAppsFile`, `checkPublicKeys`).
2. **`apps.json`-bejegyzés és feltöltő kulcs**: `dir`, `keys`, `contentKeys`, `origins`, `corp` (SPEC 6.), és egy
   `rrsync`-re korlátozott `authorized_keys`-sor az app könyvtárára (SPEC 8.). Lépésről lépésre:
   a repó `deploy/README.md`-je, „Feltöltő kulcs és új app”.
3. **URL-aláírás a backendben**: `createUrlSigner(…)`. A böngészős link egy könyvtár-tokennel készül a hatókörre
   (lejárat `min(tokenExp, most + maxTtl)`, `?v=` a `sha256`-ból, `_`/hatókör/biztonság/kiterjesztés-szűrés); ami nem
   írható alá, az ok-kódként jön vissza (`SignRefusal`), naplózás nincs. Egy backend-adapter vázlata:

   ```ts
   import { createUrlSigner } from '@chromygabor/media-sdk';
   const signer = createUrlSigner({ baseUrl, app, kid, key, maxTtlSeconds: 3600, contentKid, contentKey });
   // ES256: key helyett privateKey, contentKey helyett contentPrivateKey (PKCS#8 base64url vagy KeyObject).
   // Az ECDSA-aláírás véletlenszerű; az aláíró egy memóval (≤ 10 000 bejegyzés, lejárattal) tartja, hogy ugyanarra
   // a bemenetre a link a lejáratig bájtra azonos legyen (böngésző-cache). Egy aláíró = egy memó: példányonként egy.

   // Böngészős linkek egy hatókör-könyvtárra (pl. a lecke könyvtára, `/`-re végződik):
   const { expiresAt, results } = signer.signDirectory({
     scopeDir: 't/lessons/ch-01-l01/', userId, tokenExp,   // tokenExp: a munkamenet lejárata (unix mp) vagy null
     assets: [{ assetKey: 't/lessons/ch-01-l01/m01.720p.mp4', sha256 }],
   });
   for (const r of results) {
     if ('url' in r) use(r.url, expiresAt);
     else log(r.error);   // 'reserved' | 'out-of-scope' | 'unsafe' | 'unsupported-type' | 'bad-scope' | 'rejected'
   }

   // Tartalomkiadás (tartalomkulccsal, /<app>/_content/<v>.json.gz, 5 perc):
   const content = signer.signContentFile('2026.11.23-1');   // { url, expiresAt } vagy { error }
   ```

4. **Teszt**: `startFakeMediaServer(…)` és `testKeys` a `@chromygabor/media-sdk/testing`-ből. A hamis szerver a valódi
   szabályaival dönt (ellenőrzési sorrend és státuszkódok, kiterjesztés-tábla, `Range`, CORS, a SPEC 5. fejlécei), a
   fájlt a `<root>/<dir>/<assetKey>`-ből adja; a `testKeys` a közös tesztvektorok CSAK TESZT kulcsai egy kész
   `apps.json`-nal. Korlátok (`429`, `503`) és napló nincs benne: azt a valódi szerver docker-tesztje fedi
   (`pnpm test:docker`). Ha a tesztelt oldal és a hamis szerver hosztja eltér (pl. az oldal `localhost`, a
   média `127.0.0.1`), a CORP `same-site` alapértéke miatt a böngésző (Chrome) a választ blokkolja: ilyenkor a
   teszt-`apps.json`-ba `corp: "cross-origin"` kell (`testAppsFile({ corp: 'cross-origin' })`).

   ```ts
   import { createUrlSigner } from '@chromygabor/media-sdk';
   import { startFakeMediaServer, testKeys } from '@chromygabor/media-sdk/testing';

   const fake = await startFakeMediaServer({ apps: testKeys.apps, root });   // a fájl: <root>/<assetKey> (dir: '.')
   const signer = createUrlSigner({ ...testKeys, baseUrl: fake.url, maxTtlSeconds: 3600 });
   // ES256-tal: createUrlSigner({ app: testKeys.app, ...testKeys.es256, baseUrl: fake.url, maxTtlSeconds: 3600 })
   // … a tesztelt kód a signer linkjeit kéri le …
   expect(fake.requests.map((r) => r.status)).toEqual([200]);
   fake.override = { status: 500 };        // vagy { delayMs }, { body, headers }, { truncateAt }, vagy egy (async) függvény
   await fake.close();
   ```

## Felület

| Függvény | Mit csinál |
| --- | --- |
| `signToken({ key \| privateKey, tokenPath, expires, params: { kid, u? } })` | a `HS256-…` (`key`) vagy `ES256-…` (`privateKey`) token |
| `buildSignedPath({ key \| privateKey, kid, tokenPath, expires, u?, path })` | a teljes aláírt útvonal; csak a szerver által elfogadható linket írja alá (különben `RangeError`) |
| `parseSignedPath(rawRequestUri)` | a nyers URI szigorú szétszedése (SPEC 1.) |
| `verifySignedPath(rawRequestUri, lookupApp, now)` | ellenőrzés a szerver sorrendjében (SPEC 4.): `status` és `reason` |
| `appLookupFrom(apps)` | kulcskereső egy `{ <app>: { keys, contentKeys } }` objektumból (csak saját mezők) |
| `bucketExpires(now, { hours = 6 })` | az óra eleje + 6 óra (próbalinkekhez) |
| `isSafeSegment`, `isSafeMediaPath`, `isSafeTokenPath`, `isPrefixOf`, `classifyMediaPath` | útvonal-szabályok (SPEC 2.1, 3.) |
| `MEDIA_CONTENT_TYPES`, `CONTENT_DIR`, `CONTENT_FILE_EXT`, `CONTENT_FILE_TYPE` | kiterjesztés-tábla (SPEC 3.) |
| `createUrlSigner({ baseUrl, app, kid?, key? \| privateKey?, maxTtlSeconds?, contentKid?, contentKey? \| contentPrivateKey?, contentTtlSeconds?, now? })` | URL-aláíró: `signDirectory(…)` (böngészős linkek egy hatókörre) és `signContentFile(version)` (tartalom-token); az elutasítás ok-kódja `SignRefusal`. ES256-ra aláírás-memó (`kid` + aláírt szöveg → token) |
| `MEDIA_URL_VERSION_LENGTH`, `CONTENT_TOKEN_TTL_SECONDS`, `SIGNATURE_MEMO_MAX_ENTRIES` | a `?v=` hossza (12), a tartalom-token alap-élettartama (300 mp) és az aláírás-memó mérete (10 000) |
| `PUBLIC_KEY_RE`, `isValidPublicKey`, `isValidPrivateKey`, `KEY_ID_RE`, `KEY_RE`, `isValidKeyId`, `isValidKey` | kulcs- és `kid`-alakok (SPEC 6.) |
| `base64url`, `timingSafeEqualStr` | segédek |

`@chromygabor/media-sdk/apps-config` (az `apps.json`, SPEC 6.):

| Függvény / típus | Mit csinál |
| --- | --- |
| `AppEntry`, `AppsFile`, `AppCorp`, `APP_CORP_VALUES` | az `apps.json` típusai (`dir`, `keys`, `contentKeys`, `origins?`, `corp?`) |
| `validateAppsFile(value)` | a szerver (njs `validateApps`) szabályai: `{ ok: true, apps }` vagy `{ ok: false, errors }`; a hibaüzenet kulcsot nem idéz |
| `isValidAppName(name)` | app-név: biztonságos szegmens, nem `_`-os |
| `generateKey()` | új kulcs: 32 véletlen bájt base64url-szövege (43 jel) |
| `defaultKid(content, now?, asymmetric?)` | alap `kid`: `<év>a` / `<év>c`, ES256-ra `<év>e` / `<év>f` |
| `addKey(apps, { app, kid, key, content, dir? })` | kulcs hozzáadása (új objektum; új app `dir` = app-név, `origins: []`, `corp: same-site`); meglévő `kid`-re hiba |
| `generateKeyPair()`, `publicKeyOf(privateKey)` | ES256 kulcspár (`{ privateKey, publicKey }`), illetve a titkoshoz tartozó nyilvános kulcs |
| `addPublicKey(apps, { app, kid, publicKey, content, dir? })` | nyilvános kulcs felvétele (`publicKeys` / `contentPublicKeys`); meglévő `kid`-re vagy kulcsra hiba |
| `checkPublicKeys(apps)` | a nyilvános kulcsok görbe-ellenőrzése (a hibák listája, kulcs nélkül) |

`@chromygabor/media-sdk/testing` (csak tesztkódból):

| Függvény / típus | Mit csinál |
| --- | --- |
| `startFakeMediaServer({ apps, root, now?, port?, host?, routes? })` | hamis médiaszerver (`node:http`) a SPEC szabályaival; a fájl `<root>/<dir>/<assetKey>`. Visszaad: `{ url, requests, override, close() }`. Hibás `apps` mellett minden médiakérés `403 apps-invalid`; `/healthz` → `204`, `OPTIONS` → `204`, más metódus `405` |
| `FakeMediaServer.requests` | a kérések naplója (`method`, `uri`, `path` token nélkül, `expires`, `range`, `origin`, `verify`, `status`). A `verify` érkezéskor számolódik, és a tartás (`delayMs`, `override`-függvény) után a pillanatnyi órával újra: tartás közben (`status` = `0`) még az érkezéskori eredmény, a válasz után a döntő |
| `FakeMediaServer.override` | eltérés a szabályos választól: `{ status?, delayMs?, body?, headers?, truncateAt? }`, vagy egy kérésenként hívott (async) függvény – amíg ez vár, a kérés is; a token utána, a pillanatnyi órával dől el |
| `now` / `routes` | az óra (Unix-ezredmásodperc, mint a `createUrlSigner`-nél) és saját végpontok (pl. egy másik folyamatból hívható vezérlő) |
| `testKeys` | CSAK TESZT: `{ app: 'test-app', kid, key, contentKid, contentKey, es256, apps }` a közös tesztvektorokból; a `createUrlSigner`-nek szétteríthető (ES256-hoz a `testKeys.es256`: `kid`, `privateKey`, `publicKey`, `contentKid`, `contentPrivateKey`, `contentPublicKey`). A hamis szerver mindkét sémát ismeri (`wrong-scheme` is); a hibás aláírásokat nem számolja (a valódi szerver elhagyható `429`-e nincs benne). Mélyen fagyasztott (az `apps` is), módosítani nem lehet |
| `testAppsFile({ app?, dir?, origins?, corp? })` | ugyanezekkel a kulcsokkal (a `publicKeys` / `contentPublicKeys` is) más app-névre, `dir`-re, `origins`-re, `corp`-ra (alapból `dir: '.'`); friss, módosítható objektum. A `corp: 'cross-origin'` kell, ha az e2e oldal és a hamis szerver hosztja eltér (`localhost` / `127.0.0.1`) |

Parancsok (`bin`): `media-keys` és `media-sign` (`--help`). Az `apps.json` útvonalát argumentumként kapják
(`--write`, illetve az `--apps`), alapértelmezett útvonal nincs. A `media-keys --keypair` fájlt nem ír; a
`--register` kid-ütközésre hibát ad, és soha nem ír felül. A `media-sign --env` / `--env-file` az app saját env-jéből
(SPEC 9.) ír alá, `apps.json` nélkül; ES256-os `kid`-hez csak így lehet (az `--apps` mód érthető hibát ad). A hibás JSON-ú fájl hibaüzenete a fájl
szövegét nem idézi (legfeljebb sort és oszlopot ad).

## Közös tesztvektorok

`test-vectors.json` (exportálva: `@chromygabor/media-sdk/test-vectors.json`) – ezt olvassa a TS-teszt (`src/vectors.spec.ts`)
és a médiaszerver njs-tesztje is. A `sign` esetek közül a `source: "bunny-official-nodejs@<commit>"` jelölésűek a Bunny
hivatalos Node-példájának (`BunnyCDN.TokenAuthentication/nodejs/token.js`) kimenetével bájtra egyeznek (egyszer,
kézzel ellenőrizve; a Bunny kódját nem vettük át). A `verify` esetek `expected` mezője: `status` (`200` = elfogadva,
`403`/`404`/`410`) és `reason` (a hiba oka, a naplóhoz); elfogadásnál `app`, `kid`, `u`, `kind`, `contentType`.
A kulcsok **csak teszt** kulcsok.

```
pnpm --filter @chromygabor/media-sdk test
pnpm --filter @chromygabor/media-sdk check:standalone   # pack + telepítés egy üres projektbe
```

## Forrás és licenc

A csomag forrása a szerverrel együtt a `chromygabor/media-server` repó `packages/media-sdk` könyvtára. Licenc: MIT
(a repó gyökerének `LICENSE`-e).
