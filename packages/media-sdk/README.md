# @workspace/media-token

A védett médiaszerver aláírt URL-je (Bunny V2 directory-token, IP-kötés nélkül, `kid` és `u` kiegészítéssel).
Tervek: a terv 4.1–4.4, az implementációs terv WP1.
Futásidejű függőség nincs (`node:crypto`). A backend (MS2-ig) nem használja.

```
/bcdn_token=HS256-<sig>&kid=<kid>&token_path=<kódolt előtag>[&u=<uuid>]&expires=<unix>/<app>/<assetKey>

sig = Base64URL(HMAC-SHA256(kulcs, token_path + expires + "kid=…&token_path=…[&u=…]"))
```

- A HMAC kulcsa a kulcs **szövege** (UTF-8), ahogy a Bunny is használja; az `apps.json` base64-szövegét nem dekódoljuk.
- Böngészős tokennél a `token_path` `/`-re végződő könyvtár; tartalomtokennél (`/<app>/_content/<v>.json.gz`) pontosan a fájl, `u` nélkül.
- Idők unix-másodpercben; lejárt, ha `now > expires`.

## Felület

| Függvény | Mit csinál |
| --- | --- |
| `signToken({ key, tokenPath, expires, params: { kid, u? } })` | a `HS256-…` token |
| `buildSignedPath({ key, kid, tokenPath, expires, u?, path })` | a teljes aláírt útvonal; csak a szerver által elfogadható linket írja alá (különben `RangeError`) |
| `parseSignedPath(rawRequestUri)` | a nyers URI szigorú szétszedése (query levágva; csak `kid`, `token_path`, `u`; kanonikus kódolás) |
| `verifySignedPath(rawRequestUri, lookupApp, now)` | ellenőrzés a terv 4.4 sorrendjében: alak `403` → kiterjesztés-tábla `404` → app, `kid`, kulcsfajta, HMAC, `token_path` `403` → lejárat `410` |
| `appLookupFrom(apps)` | kulcskereső egy `{ <app>: { keys, contentKeys } }` objektumból (csak saját mezők) |
| `bucketExpires(now, { hours = 6 })` | az óra eleje + 6 óra (vödrözött lejárat, 4.2) |
| `isSafeMediaPath`, `isSafeTokenPath`, `isPrefixOf`, `classifyMediaPath`, `MEDIA_CONTENT_TYPES` | útvonal-szabályok és kiterjesztés-tábla |
| `base64url`, `timingSafeEqualStr` | segédek |

## Közös tesztvektorok

`test-vectors.json` (exportálva: `@workspace/media-token/test-vectors.json`) – ezt olvassa a TS-teszt (`src/vectors.spec.ts`)
és a médiaszerver njs-tesztje is. A `sign` esetek közül a `source: "bunny-official-nodejs@<commit>"` jelölésűek a Bunny
hivatalos Node-példájának (`BunnyCDN.TokenAuthentication/nodejs/token.js`) kimenetével bájtra egyeznek (egyszer,
kézzel ellenőrizve; a Bunny kódját nem vettük át). A `verify` esetek `expected` mezője: `status` (`200` = elfogadva,
`403`/`404`/`410`) és `reason` (a hiba oka, a naplóhoz); elfogadásnál `app`, `kid`, `u`, `kind`, `contentType`.
A kulcsok **csak teszt** kulcsok.

```
pnpm --filter @workspace/media-token test
```
