# Változások – @chromygabor/media-sdk

A formátum a [Keep a Changelog](https://keepachangelog.com/hu/1.1.0/) mintáját követi; a verziószámozás
[szemantikus](https://semver.org/lang/hu/). A token-, URL- és kulcsformátum, valamint az aláírás bájtra
változatlansága a `test-vectors.json` vektoraival ellenőrzött; ennek megtörése főverzió-váltás.

## [Kiadatlan]

A következő kiadás `0.2.0` (0.x alatt a minor jelzi a törő változást, lásd „Törő”). A `test-vectors.json` `version`
mezője `1` marad: a meglévő vektorok bájtra változatlanok, az `es256` blokk új.

### Törő
- `VerifyFailureReason` új tagja: `wrong-scheme` (SPEC 4., 6a lépés). Egy fogyasztó kimerítő (`never`-re futó)
  `switch`-e a típusellenőrzésnél elbukik, amíg az új esetet fel nem veszi.
- `SignTokenInput` és `BuildSignedPathInput` interfész helyett típus (`SigningKey &` …): a `{ key }` vagy a
  `{ privateKey }` pontosan az egyike kell; mindkettő `TypeError`. A meglévő `{ key }`-es hívások változatlanul
  fordulnak.

### Változott
- `testKeys.apps` / `testAppsFile()`: a `publicKeys` és a `contentPublicKeys` is benne van (a `testKeys.es256`
  nyilvános kulcsaival); egy rá `toEqual`-lal néző fogyasztói teszt ezt felveszi.
- Új név: `@cry/media-sdk` → `@chromygabor/media-sdk` (docs/media-sdk-kiemeles-terv.md D90: a GitHub Packages a
  hatókört a repó tulajdonosához köti). A könyvtár marad `packages/media-sdk`; a felület és a vektorok változatlanok.

### Új
- **ES256 séma** (SPEC 1., 2., 2.1, 4., 6.; aszimmetrikus aláírás, aszimmetrikus terv
  WP50): `ES256-` + 86 jeles token (ECDSA P-256 + SHA-256 ugyanazon az aláírt szövegen, `r ‖ s`, low-S), a
  médiaszerver kiterjesztése, Bunny-megfelelője nincs; a HS256 változatlanul megmarad. A séma a `kid`-ből jön:
  - `signToken` / `buildSignedPath`: `{ privateKey }` (PKCS#8 DER base64url szöveg vagy `KeyObject`), low-S-re
    normalizált, véletlenszerű aláírás; új típus: `SigningKey`;
  - `verifySignedPath`: az `AppKeys` új, elhagyható mezői `publicKeys` / `contentPublicKeys`; 6a lépés
    (`wrong-scheme`), 6b ES256-ra low-S + `node:crypto.verify`, szinkron; a görbén kívüli nyilvános kulcs
    `bad-signature`;
  - `PUBLIC_KEY_RE`, `isValidPublicKey()`, `isValidPrivateKey()` (`.`);
  - `./apps-config`: `AppEntry.publicKeys?` / `contentPublicKeys?`, a `validateAppsFile` a négy diszjunkt
    `kid`-halmazzal és a két fajtában ismétlődő nyilvános kulcs tilalmával; `checkPublicKeys()` (görbe-ellenőrzés),
    `generateKeyPair()`, `publicKeyOf()`, `addPublicKey()` (felülírás nincs), `defaultKid(content, now, asymmetric)`
    (`<év>e` / `<év>f`);
  - `test-vectors.json`: új `es256` blokk CSAK TESZT kulcspárokkal, két rögzített tokennel és 15 verify-vektorral.
- **ES256 az aláíróban, a CLI-ben és a `./testing`-ben** (aszimmetrikus terv WP51):
  - `createUrlSigner`: `privateKey` / `contentPrivateKey` a `key` / `contentKey` helyett (egyszerre csak az egyik,
    különben `TypeError`); **aláírás-memó** (D113): a `kid` + aláírt szöveg → token, legfeljebb
    `SIGNATURE_MEMO_MAX_ENTRIES` (10 000) bejegyzés, a lejártak kiesnek, a határon a legrégebbi is; így az ES256-link
    egy munkamenet alatt bájtra azonos marad. A HMAC-ág változatlan (memó nélkül is determinisztikus);
  - `media-keys --keypair <app> [--content] [--kid]` (app oldal): új P-256 kulcspár, a backend env-sorai (titok) és az
    üzemeltetőnek küldendő sor (nyilvános kulcs, ellenőrző jelek); fájlt nem ír. `media-keys --register <app> --kid
    --public-key [--content] --write` (üzemeltető): `addPublicKey`, kid-ütközésre hiba, felülírás soha;
  - `media-sign --env` / `--env-file <.env>` (D117, a kiemelési terv WP44-éből előre hozva): apps.json nélkül, a
    SPEC 9. env-neveiből, a `MEDIA_SERVER_PRIVATE_KEYS` / `MEDIA_SERVER_CONTENT_PRIVATE_KEY`-jel is; a kulcs nem kerül
    a kimenetbe vagy a hibaüzenetbe. Az `--apps` mód egy ES256-`kid`-re érthető hibát ad. A `signUrl` egy
    `{ app, kid, key | privateKey }` bemenetet is elfogad;
  - `./testing`: `testKeys.es256` (új típus: `TestEs256Keys`), a `testAppsFile()` a `publicKeys` /
    `contentPublicKeys`-t is kitölti; a hamis szerver konformanciatesztje az `es256.verify` vektorokkal is fut; a hamis
    szerver a hibás aláírásokat nem számolja;
  - SPEC 9.: `MEDIA_SERVER_PRIVATE_KEYS`, `MEDIA_SERVER_CONTENT_PRIVATE_KEY`.
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

### Javítva
- `validateAppsFile`: a `kid`-ütközés hibaszövege „a kid több kulcstérképben is szerepel” (a négy térkép miatt); a
  `__proto__` kid ütközése az njs `validateApps`-ében is hiba (a szerver WP39-e), így itt már nincs szándékos eltérés.
- A `media-keys` / `media-sign` a hibás JSON-ú `apps.json` hibaüzenetében nem idéz a fájl szövegéből (a korábbi
  `server` szkript a `JSON.parse` üzenetét továbbadta, és a Node ebben a bemenetből, így a kulcsokból is
  idézett); az üzenet `<fájl>: az apps.json nem érvényes JSON`, legfeljebb sorral és oszloppal.
- `./testing`: a `testKeys` mélyen fagyasztott (az `apps` és benne a `keys` / `contentKeys` is); korábban csak a
  felső szint volt, így egy teszt a többi alatt átírhatta a közös teszt-`apps.json`-t.
- `./testing`: a `requests[].verify` tartás alatti értéke (az érkezéskori eredmény) dokumentálva, teszttel.

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
