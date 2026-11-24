# Változások – @cry/media-sdk

A formátum a [Keep a Changelog](https://keepachangelog.com/hu/1.1.0/) mintáját követi; a verziószámozás
[szemantikus](https://semver.org/lang/hu/). A token-, URL- és kulcsformátum, valamint az aláírás bájtra
változatlansága a `test-vectors.json` vektoraival ellenőrzött; ennek megtörése főverzió-váltás.

## [Kiadatlan]

### Új
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
