# @chromygabor/media-sdk

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

4. **Teszt** *(WP35 után)*: `startFakeMediaServer(…)` a `@chromygabor/media-sdk/testing`-ből. Addig: a backend hamis szervere
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
| `createUrlSigner({ baseUrl, app, kid?, key?, maxTtlSeconds?, contentKid?, contentKey?, contentTtlSeconds?, now? })` | URL-aláíró: `signDirectory(…)` (böngészős linkek egy hatókörre) és `signContentFile(version)` (tartalom-token); az elutasítás ok-kódja `SignRefusal` |
| `MEDIA_URL_VERSION_LENGTH`, `CONTENT_TOKEN_TTL_SECONDS` | a `?v=` hossza (12) és a tartalom-token alap-élettartama (300 mp) |
| `base64url`, `timingSafeEqualStr` | segédek |

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
