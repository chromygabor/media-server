# @cry/media-sdk

A védett médiaszerver (`server`) kliensoldala: aláírt URL (Bunny V2 directory-token, IP-kötés nélkül,
`kid` és `u` kiegészítéssel), ellenőrzés, útvonal-szabályok, közös tesztvektorok. Futásidejű függőség nincs
(`node:crypto`).

- **A protokoll normatív leírása: [`SPEC.md`](SPEC.md)** (URL-alak, token, státuszkódok, fejlécek, `apps.json`,
  kulcsforgatás, feltöltés, ajánlott env-nevek). Az indoklás: a terv 4.
- Fogyasztók a monorepóban: a backend (URL-aláíró, tartalomforrás), a frontend e2e és a
  médiaszerver CLI-jei és tesztjei.

```
/bcdn_token=HS256-<sig>&kid=<kid>&token_path=<kódolt előtag>[&u=<uuid>]&expires=<unix>/<app>/<assetKey>

sig = Base64URL(HMAC-SHA256(kulcs, token_path + expires + "kid=…&token_path=…[&u=…]"))
```

## Gyors kezdés egy új apphoz

1. **Kulcs** *(WP33 után)*: `media-keys <app> [--content] [--kid <id>] [--write <apps.json>]`.
   Addig: `pnpm media-server:keys <app> …` (`server/scripts/keys-new.ts`). Kiírja az `apps.json`-részletet
   és a backend env-értékeit (SPEC 9.). A kulcs titok.
2. **`apps.json`-bejegyzés és feltöltő kulcs**: `dir`, `keys`, `contentKeys`, `origins`, `corp` (SPEC 6.), és egy
   `rrsync`-re korlátozott `authorized_keys`-sor az app könyvtárára (SPEC 8.). Lépésről lépésre:
   [`server/README.md`](../../server/README.md) „Feltöltő kulcs és új app”.
3. **URL-aláírás a backendben** *(WP34 után)*: `createUrlSigner(…)` (lejárat `min(tokenExp, most + maxTtl)`,
   könyvtár-token, `?v=`, útvonal-szűrés). Addig: `buildSignedPath` közvetlenül, mintának a backend
   (vázlat):

   ```ts
   import { buildSignedPath } from '@cry/media-sdk';
   const path = `/${app}/${assetKey}`;
   const url = baseUrl + buildSignedPath({
     key: keys[kid], kid, u: userId, expires,
     tokenPath: `/${app}/${scopeDir}`,   // böngészős token: könyvtár, `/`-re végződik (pl. a lecke könyvtára)
     path,
   });
   ```

4. **Teszt** *(WP35 után)*: `startFakeMediaServer(…)` a `@cry/media-sdk/testing`-ből. Addig: a backend hamis szervere
   (a fogyasztó backend tesztjeiben) mintának, vagy `verifySignedPath` + `appLookupFrom` közvetlenül;
   a valódi szerver docker-tesztje: `pnpm media-server:test`.

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
| `base64url`, `timingSafeEqualStr` | segédek |

## Közös tesztvektorok

`test-vectors.json` (exportálva: `@cry/media-sdk/test-vectors.json`) – ezt olvassa a TS-teszt (`src/vectors.spec.ts`)
és a médiaszerver njs-tesztje is. A `sign` esetek közül a `source: "bunny-official-nodejs@<commit>"` jelölésűek a Bunny
hivatalos Node-példájának (`BunnyCDN.TokenAuthentication/nodejs/token.js`) kimenetével bájtra egyeznek (egyszer,
kézzel ellenőrizve; a Bunny kódját nem vettük át). A `verify` esetek `expected` mezője: `status` (`200` = elfogadva,
`403`/`404`/`410`) és `reason` (a hiba oka, a naplóhoz); elfogadásnál `app`, `kid`, `u`, `kind`, `contentType`.
A kulcsok **csak teszt** kulcsok.

```
pnpm --filter @cry/media-sdk test
pnpm --filter @cry/media-sdk check:standalone   # pack + telepítés egy üres projektbe
```
