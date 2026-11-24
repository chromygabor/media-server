# @chromygabor/media-sdk

A védett médiaszerver (`server`) kliensoldala: aláírt URL (Bunny V2 directory-token, IP-kötés nélkül,
`kid` és `u` kiegészítéssel), ellenőrzés, útvonal-szabályok, közös tesztvektorok. Futásidejű függőség nincs
(`node:crypto`).

- **A protokoll normatív leírása: [`SPEC.md`](SPEC.md)** (URL-alak, token, státuszkódok, fejlécek, `apps.json`,
  kulcsforgatás, feltöltés, ajánlott env-nevek). Az indoklás: a terv 4.
- Fogyasztók a monorepóban: a backend (URL-aláíró, tartalomforrás, a tesztjei a
  `./testing`-gel), a frontend e2e (`./testing`) és a médiaszerver tesztjei; a gyökér `pnpm media-server:keys` / `:sign` a csomag parancsait hívja.

```
/bcdn_token=HS256-<sig>&kid=<kid>&token_path=<kódolt előtag>[&u=<uuid>]&expires=<unix>/<app>/<assetKey>

sig = Base64URL(HMAC-SHA256(kulcs, token_path + expires + "kid=…&token_path=…[&u=…]"))
```

## Gyors kezdés egy új apphoz

1. **Kulcs**: `media-keys <app> [--content] [--kid <id>] [--write <apps.json>] [--dir <könyvtár>]` (a monorepóban
   `pnpm media-server:keys …`). Kiírja az `apps.json`-részletet és a backend env-értékeit (SPEC 9.); `--write`-tal
   hozzáadja a fájlhoz (meglévő `kid`-et nem ír felül). A kulcs titok. Próbalink: `media-sign --apps <apps.json>
   <app> <assetKey> [--u <uuid>] [--content] [--base <url>]`. Programból: `@chromygabor/media-sdk/apps-config`
   (`generateKey`, `addKey`, `validateAppsFile`).
2. **`apps.json`-bejegyzés és feltöltő kulcs**: `dir`, `keys`, `contentKeys`, `origins`, `corp` (SPEC 6.), és egy
   `rrsync`-re korlátozott `authorized_keys`-sor az app könyvtárára (SPEC 8.). Lépésről lépésre:
   [`server/README.md`](../../server/README.md) „Feltöltő kulcs és új app”.
3. **URL-aláírás a backendben**: `createUrlSigner(…)`. A böngészős link egy könyvtár-tokennel készül a hatókörre
   (lejárat `min(tokenExp, most + maxTtl)`, `?v=` a `sha256`-ból, `_`/hatókör/biztonság/kiterjesztés-szűrés); ami nem
   írható alá, az ok-kódként jön vissza (`SignRefusal`), naplózás nincs. A backend adapterje mintának:
   URL-aláírója.

   ```ts
   import { createUrlSigner } from '@chromygabor/media-sdk';
   const signer = createUrlSigner({ baseUrl, app, kid, key, maxTtlSeconds: 3600, contentKid, contentKey });

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
   (`pnpm media-server:test`).

   ```ts
   import { createUrlSigner } from '@chromygabor/media-sdk';
   import { startFakeMediaServer, testKeys } from '@chromygabor/media-sdk/testing';

   const fake = await startFakeMediaServer({ apps: testKeys.apps, root });   // a fájl: <root>/<assetKey> (dir: '.')
   const signer = createUrlSigner({ ...testKeys, baseUrl: fake.url, maxTtlSeconds: 3600 });
   // … a tesztelt kód a signer linkjeit kéri le …
   expect(fake.requests.map((r) => r.status)).toEqual([200]);
   fake.override = { status: 500 };        // vagy { delayMs }, { body, headers }, { truncateAt }, vagy egy (async) függvény
   await fake.close();
   ```

## Felület

| Függvény | Mit csinál |
| --- | --- |
| `signToken({ key, tokenPath, expires, params: { kid, u? } })` | a `HS256-…` token |
| `buildSignedPath({ key, kid, tokenPath, expires, u?, path })` | a teljes aláírt útvonal; csak a szerver által elfogadható linket írja alá (különben `RangeError`) |
| `parseSignedPath(rawRequestUri)` | a nyers URI szigorú szétszedése (SPEC 1.) |
| `verifySignedPath(rawRequestUri, lookupApp, now)` | ellenőrzés a szerver sorrendjében (SPEC 4.): `status` és `reason` |
| `appLookupFrom(apps)` | kulcskereső egy `{ <app>: { keys, contentKeys } }` objektumból (csak saját mezők) |
| `bucketExpires(now, { hours = 6 })` | az óra eleje + 6 óra (próbalinkekhez) |
| `isSafeSegment`, `isSafeMediaPath`, `isSafeTokenPath`, `isPrefixOf`, `classifyMediaPath` | útvonal-szabályok (SPEC 2.1, 3.) |
| `MEDIA_CONTENT_TYPES`, `CONTENT_DIR`, `CONTENT_FILE_EXT`, `CONTENT_FILE_TYPE` | kiterjesztés-tábla (SPEC 3.) |
| `createUrlSigner({ baseUrl, app, kid?, key?, maxTtlSeconds?, contentKid?, contentKey?, contentTtlSeconds?, now? })` | URL-aláíró: `signDirectory(…)` (böngészős linkek egy hatókörre) és `signContentFile(version)` (tartalom-token); az elutasítás ok-kódja `SignRefusal` |
| `MEDIA_URL_VERSION_LENGTH`, `CONTENT_TOKEN_TTL_SECONDS` | a `?v=` hossza (12) és a tartalom-token alap-élettartama (300 mp) |
| `base64url`, `timingSafeEqualStr` | segédek |

`@chromygabor/media-sdk/apps-config` (az `apps.json`, SPEC 6.):

| Függvény / típus | Mit csinál |
| --- | --- |
| `AppEntry`, `AppsFile`, `AppCorp`, `APP_CORP_VALUES` | az `apps.json` típusai (`dir`, `keys`, `contentKeys`, `origins?`, `corp?`) |
| `validateAppsFile(value)` | a szerver (njs `validateApps`) szabályai: `{ ok: true, apps }` vagy `{ ok: false, errors }`; a hibaüzenet kulcsot nem idéz |
| `isValidAppName(name)` | app-név: biztonságos szegmens, nem `_`-os |
| `generateKey()` | új kulcs: 32 véletlen bájt base64url-szövege (43 jel) |
| `defaultKid(content, now?)` | alap `kid`: `<év>a` / `<év>c` |
| `addKey(apps, { app, kid, key, content, dir? })` | kulcs hozzáadása (új objektum; új app `dir` = app-név, `origins: []`, `corp: same-site`); meglévő `kid`-re hiba |

`@chromygabor/media-sdk/testing` (csak tesztkódból):

| Függvény / típus | Mit csinál |
| --- | --- |
| `startFakeMediaServer({ apps, root, now?, port?, host?, routes? })` | hamis médiaszerver (`node:http`) a SPEC szabályaival; a fájl `<root>/<dir>/<assetKey>`. Visszaad: `{ url, requests, override, close() }`. Hibás `apps` mellett minden médiakérés `403 apps-invalid`; `/healthz` → `204`, `OPTIONS` → `204`, más metódus `405` |
| `FakeMediaServer.requests` | a kérések naplója (`method`, `uri`, `path` token nélkül, `expires`, `range`, `origin`, `verify`, `status`) |
| `FakeMediaServer.override` | eltérés a szabályos választól: `{ status?, delayMs?, body?, headers?, truncateAt? }`, vagy egy kérésenként hívott (async) függvény – amíg ez vár, a kérés is; a token utána, a pillanatnyi órával dől el |
| `now` / `routes` | az óra (Unix-ezredmásodperc, mint a `createUrlSigner`-nél) és saját végpontok (pl. egy másik folyamatból hívható vezérlő) |
| `testKeys` | CSAK TESZT: `{ app: 'test-app', kid, key, contentKid, contentKey, apps }` a közös tesztvektorokból; a `createUrlSigner`-nek szétteríthető |
| `testAppsFile({ app?, dir?, origins?, corp? })` | ugyanezekkel a kulcsokkal más app-névre, `dir`-re, `origins`-re, `corp`-ra (alapból `dir: '.'`) |

Parancsok (`bin`): `media-keys` és `media-sign` (`--help`). Az `apps.json` útvonalát argumentumként kapják
(`--write`, illetve a kötelező `--apps`), alapértelmezett útvonal nincs. A hibás JSON-ú fájl hibaüzenete a fájl
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

## Kiemelés külön repóba (recept)

A csomag úgy készült, hogy a tartalmához nyúlás nélkül kiemelhető legyen: nincs `workspace:` függősége, és nem
importál a saját könyvtárán kívülről (ezt a `check:standalone` tartja be). A kiemelés lépései:

1. **History** egy friss, `--no-local` klónon (a munkafa érintetlen marad), `git filter-repo`-val, a csomag
   útvonalát a repó gyökerére képezve:

   ```bash
   git clone --no-local --single-branch --branch master <monorepó-URL> media-sdk && cd media-sdk
   git filter-repo --path packages/media-sdk/ --path-rename packages/media-sdk/: --prune-empty always --refs master
   ```

   Ha a csomagnak korábban más útvonala is volt (`git log --follow --name-status -- packages/media-sdk/package.json`
   a monorepóban), azt is fel kell venni egy `--path` / `--path-rename` párral, különben az átnevezés előtti
   történet elvész. Ugyanezért nem `git subtree split --prefix packages/media-sdk`: az csak egy útvonalat követ.
   Push előtt audit: a `git rev-list --all --objects` útvonalai között csak a csomag fájljai lehetnek.
2. **Az új repóban**: saját `.gitignore` (`dist/`, `node_modules/`), lockfile, CI (typecheck, lint, test, build,
   `check:standalone`), a `private: true` helyett `publishConfig` a választott regisztryre, kiadás tagre.
3. **A fogyasztókban**: a `"@chromygabor/media-sdk": "workspace:*"` helyére a publikált verzió (pl. `^1.0.0`; a
   szerver tesztjeinél pontos verzió, mert azok a protokoll-paritás tanúi), a hatókör regisztryje az `.npmrc`-be,
   majd a `packages/media-sdk` törlése a monorepóból. Az importok és a `test-vectors.json` útvonala nem változik.
