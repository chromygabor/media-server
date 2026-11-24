# Változások – @chromygabor/media-sdk

A formátum a [Keep a Changelog](https://keepachangelog.com/hu/1.1.0/) mintáját követi; a verziószámozás
[szemantikus](https://semver.org/lang/hu/). A token-, URL- és kulcsformátum, valamint az aláírás bájtra
változatlansága a `test-vectors.json` vektoraival ellenőrzött; ennek megtörése főverzió-váltás.

## [Kiadatlan]

### Változott
- Új név: `@cry/media-sdk` → `@chromygabor/media-sdk` (docs/media-sdk-kiemeles-terv.md D90: a GitHub Packages a
  hatókört a repó tulajdonosához köti). A könyvtár marad `packages/media-sdk`; a felület és a vektorok változatlanok.

### Új
- `./testing` alútvonal (`src/testing/`; csomagterv WP35): `startFakeMediaServer({ apps, root,
  now?, port?, host?, routes? })` – hamis médiaszerver `node:http`-n a SPEC szabályaival (ellenőrzési sorrend és
  státuszkódok, kiterjesztés-tábla, `<root>/<dir>/<assetKey>`, `Range` → `206`/`416`, `HEAD`, `ETag`/`304`,
  `If-Range`, CORS az `origins`-ből, CORP, `Cache-Control`, `/healthz`, `OPTIONS`, `405`, hibás `apps.json` →
  `403 apps-invalid`), a `requests` naplóval és az `override`-dal (státusz, késleltetés, törzs, fejléc, rövidített
  `206`; függvényként kérésenként, aszinkron is); `testKeys` és `testAppsFile()` – a közös tesztvektorok CSAK TESZT
  kulcsai egy kész `apps.json`-nal. Konformanciateszt: a `verify` vektorok HTTP-státusza azonos a valódi szerverével.
  A backend és a frontend e2e saját hamis szervere erre épül.
- `./apps-config` alútvonal (`src/apps-config.ts`; csomagterv WP33): az `apps.json` típusai
  (`AppEntry`, `AppsFile`, `AppCorp`, `APP_CORP_VALUES`), `validateAppsFile()` a médiaszerver njs `validateApps`
  szabályaival (`{ ok: true, apps } | { ok: false, errors }`; az elfogadás és a hibák száma azonos, a hibaüzenet
  kulcsot nem idéz), `isValidAppName()`, `generateKey()`, `defaultKid()`, `addKey()`.
- `media-keys` és `media-sign` parancs (`bin`; korábban `server/scripts/keys-new.ts`, `sign.ts`): azonos
  paraméterek, kimenet és fájlkezelés, de az `apps.json` útvonala argumentum (`--write`, illetve a most kötelező
  `--apps`), és van `--help`. Hibánál egy sor a stderr-re (verem nélkül); a hibás JSON-ú `apps.json` hibaüzenete a
  fájl szövegét (benne a kulcsokat) nem idézi; `--write` után figyelmeztetés, ha a fájl tartalmilag hibás.
- `createUrlSigner()` (`src/signer.ts`; csomagterv WP34): `signDirectory()` böngészős linkekre
  egy hatókör-könyvtárra (könyvtár-token, `expires = min(tokenExp, most + maxTtlSeconds)`, `?v=` a `sha256` első 12
  jeléből, `_`/hatókör/biztonság/kiterjesztés-szűrés) és `signContentFile()` a tartalomkiadásra (tartalomkulcs,
  fájlra szóló `token_path`, most + `contentTtlSeconds`, alapból 300). Naplózás nincs: az elutasítás ok-kódja
  `SignRefusal` (`reserved`, `out-of-scope`, `unsafe`, `unsupported-type`, `bad-scope`, `rejected`). Új konstansok:
  `MEDIA_URL_VERSION_LENGTH`, `CONTENT_TOKEN_TTL_SECONDS`. A fogyasztó backend URL-aláírója és tartalomforrása erre
  épül.
- `KEY_ID_RE`, `KEY_RE`, `isValidKeyId()`, `isValidKey()` (`src/keys.ts`; csomagterv WP32): a
  `kid` és a kulcs alakja, bájtra azonosan a médiaszerver njs `ID_RE`-jével és `KEY_RE`-jével. A backend env-sémája
  ezeket használja; a backend `MEDIA_CONTENT_TYPES`-másolata helyett a csomag táblája.

## [0.1.0] – 2026-11-24

### Változott
- Új név és hely: `@workspace/media-token` → `@cry/media-sdk`, `packages/media-token` → `packages/media-sdk`
  (csomagterv WP30, D1). A fogyasztók (backend, frontend e2e, médiaszerver) importjai átírva.
- `version 0.1.0`, `private: true`, `license: UNLICENSED` (D4) a kiemelésig.
- Önálló build: a `tsconfig.json` nem örököl a monorepó `@workspace/tsconfig`-jából (a beállítások kifejtve), és a
  csomagnak nincs `workspace:` függősége.
- A hibaüzenetek előtagja `media-token:` helyett `media-sdk:`.

### Új
- `check:standalone` (`scripts/check-standalone.sh`): statikus ellenőrzés (nincs `@workspace/` hivatkozás, a
  csomagkönyvtárból kilépő import, `extends`, futásidejű függőség), majd `pnpm pack`, telepítés egy üres projektbe
  `npm install`-lal, ESM- és CJS-próba minden alútvonalra és egy aláírási vektorra.

### Változatlan
- A felület (`.`: `signToken`, `buildSignedPath`, `parseSignedPath`, `verifySignedPath`, `appLookupFrom`,
  `bucketExpires`, útvonal-szabályok és kiterjesztés-tábla; `./test-vectors.json`) és a vektorok bájtra azonosak.
