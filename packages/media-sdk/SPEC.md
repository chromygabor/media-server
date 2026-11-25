# A védett médiaszerver protokollja (SPEC)

Ez a leírás **normatív**: a médiaszerver (`server`: nginx + njs) és a `@chromygabor/media-sdk` ennek felel meg,
annak `./testing` hamis szervere is (a korlátok – 5. pont – és a napló nélkül).
A tervezési előzmények nem részei a repónak; ha bármely más leírás ettől eltér, ez az irányadó. A kulcsszavak: **kell** / **nem szabad** (kötelező), **ajánlott**.

Minden állítás mögött zárójelben a teszt, amely fedi (a csomagon belül a `src/`-hez, a szerveré a repó gyökeréhez képest):

| Jel | Teszt |
| --- | --- |
| **V** | `test-vectors.json` közös vektorai: a TS (`src/vectors.spec.ts`), az njs Node alatt (`server/test/njs.spec.ts`), az njs a konténer CLI-jén, `njs` és `QuickJS` motorral (`media.docker.spec.ts` „a közös vektorok…”), és a `./testing` hamis szervere HTTP-n (`src/testing/fake-server.spec.ts` „konformancia”); a `verify` vektoroknál a `status` és a `reason` is egyezik |
| **T** | a csomag saját tesztjei: `src/token.spec.ts`, `src/path.spec.ts`, `src/expires.spec.ts`, `src/token.property.spec.ts`, `src/signer.spec.ts`, `src/signer.property.spec.ts` |
| **N** | `server/test/njs.spec.ts` (njs Node alatt: TS-paritás fast-checkkel, `validateApps`, js_set-kimenetek, fejlécszűrő) |
| **C** | `server/test/config.spec.ts` (konfigfájlok összhangja) |
| **D** | `server/test/docker/media.docker.spec.ts` (a futó konténer HTTP-n) |
| **K** | `src/cli/cli.spec.ts` (a `media-keys` / `media-sign` parancs: kulcsgenerálás, próbalink) és `src/apps-config.spec.ts` (`validateAppsFile`) |

Az `es256` blokk vektorait (ES256 séma) ugyanez a négy futtatja: a TS, az njs Node alatt, a konténer CLI-je és a hamis
szerver (V).

A teszt nélküli állítás jelölése: *(teszt nélkül)*, egy fél mondatos indokkal; egy egész lépéssornál (7., 10. pont) a
pont elején, egyszer. Minden idő unix-másodperc.

A két fél: az **app** (egy fogyasztó: a backendje ír alá, a feltöltője tölt fel) és az **üzemeltető** (a szerver
gazdája: `apps.json`, célgép, feltöltő kulcsok). Az app a szerverhez és az `apps.json`-hoz nem fér hozzá; a kettő
kapcsolatát a 10. pont (App-regisztráció) írja le.

## 1. URL-alak

```
<alap-URL>/bcdn_token=<séma>-<sig>&kid=<kid>&token_path=<kódolt előtag>[&u=<u>]&expires=<n>/<app>/<assetKey>[?…]
```

- Az első szegmens `/bcdn_token=`-nel kezdődik, a következő `/`-ig tart; utána a kért útvonal (`path`). (V, T)
- A szegmensben `&`-rel: elöl a `bcdn_token`, a végén az `expires`, köztük csak a `kid`, a `token_path` és az
  `u`, mindegyik legfeljebb egyszer; a `kid` és a `token_path` kötelező. Más paraméter `unknown-param`, ismétlés
  `duplicate-param`, hiány `missing-param`. (V, T)
- A köztes paraméterek sorrendje az ellenőrzésnél nem kötött; aláíráskor kulcs szerint rendezve írjuk ki
  (`kid`, `token_path`, `u`). (T: „a paraméterek sorrendje nem kötött”)
- Az értékek **kanonikusan** kódoltak: `encodeURIComponent(érték) === nyers`, üres érték nincs; különben
  `malformed-param`. A `token_path` kódolt (`/` → `%2F`). (V: „nem kanonikus kódolás”, „kódolatlan token_path”; T)
- `token`: `HS256-` + pontosan 43 Base64URL-jel (`[A-Za-z0-9_-]`, kitöltés nélkül), **vagy** `ES256-` + pontosan 86
  Base64URL-jel, amelynek utolsó jele kanonikus (a 64 bájt kitöltő bitjei nullák: `[AQgw]`); más `malformed-token`. Az
  IP-kötés `HS256-1-` alakja nem elfogadott. (V: „csonka token”, „IP-kötés jelzője”, `es256`: „ES256 nem kanonikus
  utolsó jel”, „ES256 85 jeles token”; T)
- `expires`: `0` vagy vezető nulla nélküli, legfeljebb 12 jegyű decimális szám; más `malformed-expires`. (V, T)
- `kid` és `u`: `[A-Za-z0-9._-]{1,128}`; más `malformed-param`. (T; N: fast-check paritás)
- A query (`?…`) figyelmen kívül marad, az ellenőrzésben és a kiszolgálásban sem számít (a `?v=` gyorsítótár-törő
  így szabadon hozzáfűzhető). (V: „a query figyelmen kívül marad”, „hiányzó token, a query-ben adva”)
- A szerver a **nyers** kérés-URI-ból dolgozik (nginx `$request_uri`), nem a dekódolt `$uri`-ból. (D: `%2F`, `%2e%2e`,
  `//` esetek; C: a host-nginx `proxy_pass` URI-rész nélkül)

## 2. A token

```
token        = "HS256-" + Base64URL(HMAC-SHA256(kulcs, M))                     (HMAC, Bunny-kompatibilis)
             | "ES256-" + Base64URL(r ‖ s)                                     (ECDSA P-256 + SHA-256 az M-en)
M            = token_path + expires + signing_data
signing_data = "kid=<kid>&token_path=<token_path>[&u=<u>]"      (rendezett, kódolatlan értékek)
```

Két séma van, mindkettő elsőrangú. **A séma mindig a `kid`-ből jön, soha nem a tokenből:** a `keys`/`contentKeys`
`kid`-je `HS256-`, a `publicKeys`/`contentPublicKeys` `kid`-je `ES256-` tokent kíván (6. pont); eltérésnél
`wrong-scheme`. Így algoritmus-csere nem lehetséges. (V: `es256` „… wrong-scheme” esetek; T) Az ES256 séma a médiaszerver
kiterjesztése, Bunny-megfelelője nincs; a Bunny-kompatibilis séma a HS256.

- A Bunny V2 directory-token algoritmusa, IP nélkül, a mi két paraméterünkkel (`kid`, `u`). A két Bunny-forrású
  aláírási vektor bájtra egyezik a Bunny hivatalos Node-példájának kimenetével. (V: `source: bunny-official-nodejs@…`)
- A HMAC kulcsa a kulcs **szövege** UTF-8 bájtokként; az `apps.json` base64(url)-szövegét **nem szabad** dekódolni.
  (V: a `sign` vektorok kulcsa base64-szöveg; T)
- `u` nélkül a `signing_data`-ban nincs `&u=`. (T: „u nélkül nincs u=”)
- Base64URL: `+` → `-`, `/` → `_`, a záró `=` elhagyva. (T: „base64url”)
- Az aláírás ellenőrzése **időállandó** összehasonlítással történik. (teszt nélkül: az időállandóság, mert egy
  időmérő teszt maga volna ingadozó; a token hossza rögzített, így a hossz sem szivárog. T csak az eredményt
  nézi)
- **ES256:** ECDSA a P-256 görbén SHA-256-tal, az aláírt szöveg ugyanaz az `M` (a `kid` benne van, így egy aláírás
  nem vihető át másik `kid`-re). Az aláírás 64 bájt: `r ‖ s`, 32–32 bájt big-endian (IEEE P1363), Base64URL-ben 86 jel.
  A nyilvános kulcs a tömörítetlen pont (6. pont). (V: `es256` „helyes ES256 …”; T)
- **Low-S kötelező:** `s ≤ n/2` (`n` a P-256 rendje). Az aláíró normalizál (`s > n/2` esetén `n − s`), az ellenőrző a
  magas-S aláírást `bad-signature`-rel elutasítja, mert a WebCrypto/OpenSSL a `(r, n − s)` alakot is elfogadná, és egy
  linknek két írásmódja lenne. Az `r` vagy `s` nulla, illetve `≥ n` értéke `bad-signature`. (V: `es256` „ES256 magas-S
  változat”; T: property-teszt)
- Az ECDSA-aláírás véletlenszerű: ugyanarra a bemenetre két aláírás különbözik, ezért ES256-ra nincs bájtos aláírási
  vektor; az aláírást oda-vissza próba fedi (aláír → elfogad). (T)

### 2.1 Két tokenfajta

| | Böngészős token | Tartalomtoken |
| --- | --- | --- |
| Kulcs (HS256) | `apps[app].keys[kid]` | `apps[app].contentKeys[kid]` |
| Nyilvános kulcs (ES256) | `apps[app].publicKeys[kid]` | `apps[app].contentPublicKeys[kid]` |
| Útvonal | nem `_`-os (1. app utáni szegmens nem `_`-sal kezdődik) | `/<app>/_content/<név>.json.gz` |
| `token_path` | `/<app>/…/` könyvtár, **`/`-re végződik** | **pontosan** a kért fájl |
| `u` | ajánlott (belső felhasználó-azonosító; napló, kapcsolatkorlát) | **nem szabad** (`u-not-allowed`) |
| Lejárat | a hívó dönti (ajánlott: `min(a felhasználó tokenjének exp-je, most + 24 óra)`) | rövid (ajánlott: 5 perc) |

A kulcsfajtát (böngészős vagy tartalom) a négy térkép közül az adja, amelyikben a `kid` szerepel; egy `kid` appon belül
pontosan egy térképben lehet. (V: „helyes könyvtár-token”, „helyes tartalomtoken”, „_content/ böngészős kulccsal”, „böngészős útvonal
tartalomkulccsal”, `es256`: „publicKeys-kid _content/-re”, „contentPublicKeys-kid böngészős útvonalra”, „tartalomtoken könyvtár-token_path-szal”, „tartalomtoken u-val”; D: „_content/” blokk.
A lejárati ajánlások, ahogy a `createUrlSigner` alkalmazza: T: `src/signer.spec.ts` „expires = min(tokenExp, most +
maxTtl)…”, „… expires = most + 300”.)

- A `token_path` szabálya (az aláírás **után** nézve): `/<app>/`-pal kezdődik, ahol `<app>` a kért útvonal első
  szegmense (`token-path-app`); biztonságos szegmensekből áll (`token-path-shape`); böngészős tokennél `/`-re végződik,
  tartalomtokennél egyenlő a kért úttal (`token-path-shape`); a kért út előtagja (`outside-token-path`). A `/`-re
  végződő előtag könyvtárat jelent: a `…/ch-01-l0/` nem fedi a `…/ch-01-l01/…`-et. (V: „szomszéd-előtag” esetek,
  „token_path másik appé”, „token_path a gyökér”, „token_path ..-tal”; T: `isPrefixOf`; D: „token_path-on kívül”)
- A `u` nem titok (olvasható), de aláírt: módosítása `bad-signature`. (V: „u módosítva”; D: „módosított u”)
- A `kid` egyben a sémaváltás helye: új formátum = új `kid` (külön verzió-paraméter nincs). (teszt nélkül: konvenció
  a jövőbeli formátumváltáshoz; az ES256 séma is így, új térképben és új `kid`-del jött)
- Az aláíró (`buildSignedPath`) **csak** a szerver által elfogadható linket írja alá, különben `RangeError`.
  (T: „buildSignedPath … elutasít”; N: aláírt URI-k paritása)

## 3. Útvonal és kiterjesztés-tábla

- Útvonal: `/<app>/<assetKey>`, legalább két szegmens; minden szegmens `[A-Za-z0-9._-]+`, nem kezdődik `.`-tal. Így
  `..`, `.`, `%`, `//`, üres szegmens, záró `/` és rejtett fájl nem fér bele; ezek `403 unsafe-path`. (V: „.. az
  útvonalban”, „%2F”, „//”, „.-tal kezdődő fájl”, „. szegmens”, „könyvtár-útvonal”, „csak app”; T: `isSafeMediaPath`;
  D: „kilógó / hibás alakú útvonal”)
- Kiszolgálható fájl (minden más `404 not-servable`, érvényes tokennel is):

  | Hol | Kiterjesztés | `Content-Type` | Kulcsfajta |
  | --- | --- | --- | --- |
  | nem `_`-os útvonal | `.mp4` | `video/mp4` | böngészős |
  | nem `_`-os útvonal | `.m4a` | `audio/mp4` | böngészős |
  | nem `_`-os útvonal | `.jpg` | `image/jpeg` | böngészős |
  | `/<app>/_content/<név>.json.gz` (közvetlenül, alkönyvtár nélkül) | `.json.gz` | `application/gzip`, `Content-Encoding` nélkül | tartalom |

  A kiterjesztés kis- és nagybetűre érzékeny (`.MP4` → `404`). `_`-os az útvonal, ha az app utáni **első** szegmens
  `_`-sal kezdődik; mélyebb `_`-os szegmens nem számít (T: „csak az app utáni első szegmens számít…”; N: „mélyebb _-os szegmens…”). Más `_`-os könyvtár, `_content/`
  alkönyvtár, `_content/` alatti más fájl (pl. `.mp4`, `.sha256`) és `_content/`-en kívüli `.json.gz` `404`. (V: a `404` esetek; T: `classifyMediaPath`; C: az njs, a media-sdk és az nginx `types` táblája
  egyezik; D: „*.build.json”, „nem engedett kiterjesztés”, „.json.gz nem _content/ alatt”, `Content-Type`-ok)
- A tábla a csomagban: `MEDIA_CONTENT_TYPES`, `CONTENT_DIR`, `CONTENT_FILE_EXT`, `CONTENT_FILE_TYPE`. (C)

## 4. Ellenőrzési sorrend és státuszkódok

A szerver (és a `verifySignedPath`) pontosan ebben a sorrendben dönt; az első hiba nyer:

| # | Lépés | Státusz | `reason` |
| --- | --- | --- | --- |
| 1 | a szegmens alakja (1. pont) | `403` | `missing-token`, `malformed`, `malformed-token`, `malformed-expires`, `unknown-param`, `duplicate-param`, `missing-param`, `malformed-param` |
| 2 | az útvonal alakja (3. pont) | `403` | `unsafe-path` |
| 3 | kiterjesztés-tábla | `404` | `not-servable` |
| 4 | app az `apps.json`-ban (saját mező) | `403` | `unknown-app` |
| 5 | `kid` a fájlhoz illő kulcsfajtában (`keys` ∪ `publicKeys`, illetve `contentKeys` ∪ `contentPublicKeys`) | `403` | `unknown-kid` (egyikben sincs), `wrong-key-kind` (a másik fajtában van) |
| 6a | a token előtagja a `kid` sémája (`keys`/`contentKeys` → `HS256-`, `publicKeys`/`contentPublicKeys` → `ES256-`) | `403` | `wrong-scheme` |
| 6b | aláírás: HMAC időállandó összevetéssel; ES256 low-S + ellenőrzés | `403` | `bad-signature` |
| 7 | `token_path` (2.1) | `403` | `token-path-app`, `token-path-shape`, `u-not-allowed`, `outside-token-path` |
| 8 | lejárat: lejárt, ha `now > expires` | `410` | `expired` |
| 9 | a fájl létezése (nginx) | `404` | — |

(V: minden `reason` legalább egy vektorral, köztük „404 a token előtt”, „lejárt, de rossz aláírás → 403”, „lejárat
pillanatában még érvényes”, „kid = constructor”, „app = constructor”; N: a TS és az njs `status`-a és `reason`-je
véletlen bemeneten is azonos; T: „410 csak hiteles tokenre”, „a kulcskereső saját mezőt néz”, „üres kulcs nem kulcs”;
D: „elutasítás” blokk, „nem létező fájl érvényes tokennel → 404”)

- A `410` csak hiteles tokenre jár: a hamis, lejárt link `403`. (V, T, D)
- A `404` (3. lépés) a token előtt jön: a tábla nyilvános, nem szivárogtat. (V)
- A `wrong-scheme` csak egy ismert `kid` sémáját árulja el, ami nem titok; a naplóban elválasztja a félrekonfigurált
  appot a hamisítástól. (V: `es256`)
- Hibás vagy hiányzó `apps.json` mellett **minden** kérés `403 apps-invalid`. (N)
- Az ellenőrzés belső kivétele `403 internal-error` (kivétel nem kerülhet a hibanaplóba). (N)

További HTTP-válaszok a szervertől:

| Eset | Válasz |
| --- | --- |
| `GET /healthz` | `204`, üres, token nélkül (D) |
| `OPTIONS` bármely útvonalra | `204`, token-ellenőrzés nélkül, CORS-fejlécekkel ha az origin engedett (D) |
| nem `GET` / `HEAD` / `OPTIONS` | `405` (D: „POST → 405”) |
| `200` / `206` / `304` / `416` | az nginx statikus motorja: `Range`, `If-Range`, `If-None-Match`, `ETag`, `Last-Modified`, `HEAD` (D) |
| érvénytelen token túl gyakran ugyanarról az IP-ről | `429` (5. pont) (D) |
| ismételt hibás ES256-aláírás ugyanarról az IP-ről (**elhagyható**, szerveroldali védelem a drágább ellenőrzés előtt) | `429`, a naplóban `reason: blocked`; a `verifySignedPath` és a `./testing` hamis szervere nem számol (D) |
| felhasználónkénti / appenkénti kapcsolatkorlát túllépve | `503` (D: „limit_conn: ugyanazzal az u-val…”, „limit_conn appenként 40…”) |

A hibaválaszok törzse rövid szöveg, `Content-Type: text/plain`: `forbidden\n` (403), `not found\n` (404),
`expired\n` (410); az ok (`reason`) csak a naplóban van. (D; N: `denied`)

## 5. Válaszfejlécek, korlátok, napló

Sikeres és statikus válaszon (a fő location, a fejlécszűrő **beállít**, nem hozzáfűz; 416-nál sincs kettőzés):

| Fejléc | Érték |
| --- | --- |
| `X-Content-Type-Options` | `nosniff` (hibaválaszon is) |
| `Content-Disposition` | `inline` |
| `Cross-Origin-Resource-Policy` | `apps[app].corp`, alapból `same-site` |
| `Cache-Control` | `private, max-age=3600` böngészős fájlra `200`/`206`/`304` állapotnál; minden más (tartalomfájl, `416`, `503`, hibák) `no-store` |
| `Vary` | `Origin` |
| CORS (csak ha a kérés `Origin`-je szerepel az `apps[app].origins`-ben, pontos egyezéssel) | `Access-Control-Allow-Origin: <origin>`, `Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges`, `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`, `Access-Control-Allow-Headers: Range, If-Range`, `Access-Control-Max-Age: 600` |

(N: „headers (js_header_filter)”, „CORS: csak az app saját originje”; D: „videó: 200 … fejlécek”, „416”, „If-Range”,
„_content/ … no-store”, „CORS” blokk, „`dir: \".\"` app … CORP”.) A CORS és a CORP az útvonal első szegmenséből
jön, token-ellenőrzés nélkül (preflighthoz). (N)

A `403` / `404` / `410` / `429` hibaválaszon (a named location-ök, fejlécszűrő nélkül) csak az
`X-Content-Type-Options: nosniff` és a `Cache-Control: no-store` jár; CORS, CORP és `Vary` **nincs**. A `<video>`,
`<audio>` és `<img>` ezt nem igényli; a `hls.js` CORS nélkül a `410`-et nem látja, ezért egy HLS-lejátszó
bevezetése előtt ez újra eldöntendő. (D: „token nélkül → 403, minimális törzs, no-store”; N: `denied`)

- Tömörítés nincs (`Content-Encoding` sosem). (D)
- Korlátok (kiinduló értékek): `limit_conn` app + `u` szerint 3 (`u` nélkül nem korlátoz), appenként 40;
  `limit_rate_after 30m`, utána `limit_rate 600k`; érvénytelen tokenre (`403`) IP-nként 10 r/s, burst 20, fölötte
  `429`. (D: „a korlátok a futó konfigban”, „limit_rate_after”, „limit_conn”, „limit_req”; N: üres limit-kulcs `u`
  nélkül)
- A kliens-IP az `X-Forwarded-For`-ból, de csak a compose-hálózat átjárójától (a host-proxytól). (C, D: „napló” blokk)
- Napló: JSON-sor a stdoutra: `time`, `ip`, `method`, `app`, `kid`, `u`, `path` (token nélkül, legfeljebb 512 jel),
  `status`, `reason`, `bytes`, `rt`, `range`, `ua`. A token, a nyers URI és a query **nem szabad**, hogy a naplóba
  kerüljön, a hibanaplóba sem. (C: „napló: token nélkül”; N: `plainPath`, „a naplóútvonalban nincs token”; D: „a napló
  egésze”)

## 6. Az `apps.json`

Egy JSON-objektum, kulcsa az app neve. A szerver konfig(újra)töltéskor olvassa (`js_preload_object`); a JSON
szintaktikai hibájánál az `nginx -t` elbukik, a tartalmi hibát a `check-apps.js` jelzi a reload előtt, futás közben
pedig minden kérés `403 apps-invalid`. (D: „check-apps.js”; N: „hibás vagy hiányzó apps.json”)

```json
{
  "demo": {
    "dir": "demo",
    "keys":              { "2026a": "<legalább 43 jeles base64(url)>" },
    "contentKeys":       { "2026c": "<…>" },
    "publicKeys":        { "2026e": "<87 jeles base64url, tömörítetlen P-256 pont>" },
    "contentPublicKeys": { "2026f": "<…>" },
    "origins": ["https://app.example.com"],
    "corp": "same-site"
  }
}
```

| Mező | Szabály |
| --- | --- |
| app-név | biztonságos szegmens, nem `_`-sal kezdődik; legalább egy app kell |
| `dir` (kötelező) | `.` vagy biztonságos szegmensekből álló relatív út; a fájl: `/srv/media/<dir>/<assetKey>` (`.` → `/srv/media/<assetKey>`); több app osztozhat egy `dir`-en |
| `keys`, `contentKeys` (kötelező objektumok, lehetnek üresek) | `kid` → kulcs (HS256); `kid`: `[A-Za-z0-9._-]{1,128}`; kulcs: `^[A-Za-z0-9+/_-]{43,}={0,2}$` |
| `publicKeys`, `contentPublicKeys` (elhagyható objektumok; hiányuk = üres) | `kid` → nyilvános kulcs (ES256): a tömörítetlen P-256 pont (65 bájt: `0x04` ‖ X ‖ Y) kanonikus base64url-ben, `^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]$` (87 jel); tömörített pont, SPKI, JWK, PEM nem. A pontnak a görbén kell lennie (deploy előtt ellenőrizve). Ugyanaz a nyilvános kulcs nem lehet a `publicKeys`-ben és a `contentPublicKeys`-ben is |
| `kid`-halmazok | egy appon belül a négy térkép `kid`-halmaza páronként diszjunkt |
| `origins` (elhagyható) | tömb, elemei `http(s)://host[:port]` útvonal és záró `/` nélkül; `*` nem |
| `corp` (elhagyható) | `same-site` (alapérték), `same-origin` vagy `cross-origin` |

(K: `src/apps-config.spec.ts` a nyilvános kulcsok szabályaira és a `checkPublicKeys()` görbe-ellenőrzésére; N: „validateApps” blokk, „dir \".\" → a fájl közvetlenül a /srv/media alatt”, „böngészős token u-val: … fájl a dir
alatt”, „közös dir…”: két app egy `dir`-en, a CORP és a CORS appenként; D: „másik app saját linkje”, „`dir: \".\"` app”; C: „apps.json-validálás: njs validateApps = media-sdk
validateAppsFile”, ebben a közös `dir` is.) A csomag a szabályokat a `@chromygabor/media-sdk/apps-config`
`validateAppsFile()`-jával adja (az elfogadás és a hibák száma az njs-ével azonos).

- Kulcs generálása: 32 véletlen bájt base64url-szövege (43 jel). (K: „media-keys”) Parancs: `media-keys` (üzemeltetői
  eszköz; a szerver repójában `pnpm keys`); programból: `generateKey()` a `./apps-config`-ból.
- ES256 kulcspár: **az app generálja** (`media-keys --keypair <app> [--content]`; programból `generateKeyPair()`), a
  titkos kulcs (PKCS#8 DER base64url) soha nem hagyja el az appot; az üzemeltetőhöz csak a `kid`, a fajta és a
  nyilvános kulcs megy, aki `media-keys --register <app> --kid <kid> --public-key <…> [--content] --write <apps.json>`
  paranccsal veszi fel (programból `addPublicKey()`; meglévő `kid` felülírása nincs). (K)
- A kulcs titok: **nem szabad** repóba, naplóba, hibaüzenetbe kerülnie. Kivétel a `media-keys` stdout-ja: az új
  kulcsot szándékosan kiírja (az `apps.json`-részlet és a backend env-sorai, 9. pont); hibaüzenetbe (stderr) a kulcs
  soha nem kerül. (D: a napló nem tartalmazza a kulcsokat, „check-apps.js: szintaktikailag hibás fájl…” – a QuickJS-motoros futás ismert hibaként jelölt, a deploy az
  alapértelmezett `njs` motort használja; C: a
  `.env.example`-ben nincs kulcs; K: „hibás JSON → hiba a fájl szövege nélkül…”, a `validateAppsFile` hibaüzenete
  kulcsot nem idéz, „--write: hozzáad és kiírja…”)

## 7. Kulcsforgatás

Appenként és kulcsfajtánként (böngészős, tartalom) független, a többi app érintetlen. A forgatás eszköze a `kid`: a
régi és az új `kid` egy átfedési ideig együtt érvényes, a séma `kid`-enként választható (így HS256 → ES256 váltás is
forgatás). Ami ebből teszttel fedett: több `kid` egyidejű érvényessége, és hogy a régi törlése után a vele aláírt
link `403 unknown-kid`, az új pedig marad (T: „kulcsforgatás: több kid egyidejűleg”; V: „rossz kid”; K: „kulcsforgatás
az app oldalán: két kid az env-ben, a MEDIA_SERVER_KEY_ID választ; HS256 → ES256; …”). *(teszt nélkül: a lépéssor,
mert két fél üzemeltetési menete – kulcsátadás, `apps.json`-csere, az app élesítése –, unit-teszttel nem fedhető)*

- **Átfedés:** a régi `kid` legkorábban az app visszaigazolása (4. lépés) után, a vele kiadott leghosszabb link
  élettartamának elteltével törölhető: böngészős kulcsnál az app `MEDIA_URL_MAX_TTL`-je (9. pont), tartalomkulcsnál a
  tartalomtoken élettartama (ajánlott 5 perc). Korábban **nem szabad** törölni (kivétel: vészhelyzet, lent).
- **Az `apps.json` cseréje** (2. és 5. lépés) az üzemeltetőnél: az új fájl a célgépre, ellenőrzés (`check-apps.js`,
  `nginx -t`), majd újratöltés. Egy fájlként csatolt `apps.json` cseréje új inode-ot ad, ezért restart kell, nem
  elég a reload; a repó referencia-telepítése ezt egy lépésben végzi (`deploy/deploy.sh <cél> --reload-config`, lásd a
  `deploy/README.md`-t).

| # | HS256 (az üzemeltető generál) | ES256 (az app generál) |
| --- | --- | --- |
| 1 | Bármelyik fél kezdeményezi (ütemezett csere, személyi változás, gyanú). | ugyanaz |
| 2 | **Üzemeltető:** új `kid` + kulcs a régi mellé (`media-keys <app> --kid <új> [--content] --write <apps.json>`), az `apps.json` cseréje. | **App:** új kulcspár (`media-keys --keypair <app> --kid <új> [--content]`); a `kid`-et, a fajtát és a nyilvános kulcsot elküldi, az ellenőrző jeleket egy második csatornán (10.4). **Üzemeltető:** egyeztetés, `media-keys --register …`, az `apps.json` cseréje. |
| 3 | **Üzemeltető:** átadja az új `kid`-et és kulcsot (10.4 csatornája). | **Üzemeltető:** visszaigazolja a felvételt (`kid`, ellenőrző jelek); kulcsanyagot nem küld. |
| 4 | **App:** a `MEDIA_SERVER_KEYS`-ben a régi és az új kulcs, a `MEDIA_SERVER_KEY_ID` az új (tartalomnál a `MEDIA_SERVER_CONTENT_KEY_ID` és a `MEDIA_SERVER_CONTENT_KEY` az új); próbalink `200` (10.5); élesítés; visszaigazolás az üzemeltetőnek, időponttal. | **App:** az új titkos kulcs a `MEDIA_SERVER_PRIVATE_KEYS`-be (a régi kulcs marad, akkor is, ha HS256-os a `MEDIA_SERVER_KEYS`-ben), a `MEDIA_SERVER_KEY_ID` az új (tartalomnál a `MEDIA_SERVER_CONTENT_KEY_ID` és a `MEDIA_SERVER_CONTENT_PRIVATE_KEY`); próbalink `200`; élesítés; visszaigazolás, időponttal. |
| 5 | **Üzemeltető:** a régi `kid` törlése a visszaigazolás + az átfedés után, az `apps.json` cseréje, jelzés az appnak. | ugyanaz |
| 6 | **App:** a régi kulcs törlése az env-ből. | ugyanaz; a régi titkos kulcs megsemmisítése |

- **Feltöltő kulcs** (8. pont): az app új ed25519-kulcsot küld (csak a nyilvános felét), az üzemeltető az új
  `authorized_keys`-sort a régi mellé teszi; az app átáll az új kulcsra és jelez; az üzemeltető törli a régi sort.
- **Vészhelyzet** (kiszivárgott vagy elveszett kulcs): az üzemeltető a `kid`-et (illetve a feltöltő sort) azonnal törli,
  és értesíti az appot; az app minden vele aláírt linkje `403 unknown-kid`, a kliensek újat kérnek, de amíg az új
  `kid` nem él, az app nem tud érvényes linket adni. Az új kulcs a 2–4. lépéssel jön, átfedés nélkül.

## 8. Feltöltés

A szerver a fájlokat a `dir` alól, csak olvasva adja; a feltöltés rsync ssh-n, az app saját feltöltőjével. Az alábbi
szabályok a feltöltőre vonatkoznak (rsync-kapcsolók, kizárások, védett útvonalak); a feltöltő az app kódja, ezért
ebben a repóban nincs tesztje *(teszt nélkül: a fogyasztó a saját tesztjeivel fedi)*. A szerveroldali következmény
jelölve.

- Appenként egy **korlátozott ssh-kulcs** a feltöltő felhasználó `authorized_keys`-ében, amely csak `rrsync`-et
  enged, csak az app könyvtárába; az rsync célja az rrsync gyökere, útvonal nélkül (`<felhasználó>@<host>:`). A sor
  alakja (a `<médiagyökér>` a célgép könyvtára, amely a konténerben a `/srv/media`, a `<dir>` az app `dir`-je, 6. pont;
  a `restrict` tiltja a shellt, a terminált és a továbbításokat):

  ```
  restrict,command="/usr/bin/rrsync -munge <médiagyökér>/<dir>" ssh-ed25519 AAAA… media-upload-<app>
  ```

  *(teszt nélkül: hoszt-konfiguráció; a teszthez ssh-szerver és rrsync kellene)*
- Jogosultság a célon: `--chmod=D755,F644` (a konténer olvashassa).
- A megszakadt átvitel a `.rsync-partial/` alá kerül (`--partial-dir`); a szerver a `.`-tal kezdődő szegmenst nem
  szolgálja ki (`403 unsafe-path`; V: „.-tal kezdődő fájl”, „. szegmens”; D: „.-tal kezdődő fájl”).
- A médiafeltöltés (push) nem visz fel `*.build.json`-t, `*.part*`-ot, `.`-os fájlt és a gyökér `_content/`-jét,
  és **nem szabad** `--delete`-tel futnia (egy app több forrásból is tölthet; a többletfájl megmarad).
- A `_content/` a tartalomkiadás helye: `<v>.json.gz`, utána a `<v>.json.gz.sha256` kísérőfájl, `--ignore-existing`-gel
  (meglévő kiadás nem íródik felül). A szerver a `_content/` alól csak a `.json.gz`-t adja (3. pont; V, D).
- Törlés (prune) csak külön lépésben; a `_content/` egésze és minden `.`-os bejegyzés **védett** (rsync-szűrő:
  `P /_content/***`, `P .*`).

## 9. Ajánlott backend env-nevek

Konvenció, nem kötelező (a `media-keys` ezeket írja ki, a `media-sign --env` / `--env-file` ezeket olvassa; K:
„--write: hozzáad és kiírja …”, „--keypair”, „media-sign --env”).

| Név | Jelentés |
| --- | --- |
| `MEDIA_SERVER_URL` | a médiaszerver alap-URL-je (élesben `https://`) |
| `MEDIA_SERVER_APP` | az app neve az `apps.json`-ban |
| `MEDIA_SERVER_KEYS` | böngészős kulcsok, JSON: `{ "<kid>": "<kulcs>" }` |
| `MEDIA_SERVER_KEY_ID` | az aláíráshoz használt böngészős `kid`; pontosan az egyik térképben szerepel (`MEDIA_SERVER_KEYS` → HS256, `MEDIA_SERVER_PRIVATE_KEYS` → ES256) |
| `MEDIA_SERVER_PRIVATE_KEYS` | ES256 titkos kulcsok, JSON: `{ "<kid>": "<PKCS#8 DER base64url>" }`; a `kid`-halmaz diszjunkt a `MEDIA_SERVER_KEYS`-étől; a kettő közül legalább az egyik kell |
| `MEDIA_SERVER_CONTENT_KEY_ID`, `MEDIA_SERVER_CONTENT_KEY` | a tartalomkulcs (ha az app tölt le `_content/`-et) |
| `MEDIA_SERVER_CONTENT_PRIVATE_KEY` | ES256 tartalom-titkos kulcs, a `MEDIA_SERVER_CONTENT_KEY` helyett (a kettő kizárja egymást) |
| `MEDIA_URL_MAX_TTL` | a böngészős link leghosszabb élettartama másodpercben (ajánlott `86400`) |

## 10. App-regisztráció

Hogyan lesz egy fogyasztóból a szerver appja: a kérés, az átadás, a próba és a kivezetés. A kulcsforgatás ugyanennek
a kézfogásnak a folytatása (7. pont). *(teszt nélkül: a fejezet két fél közti eljárás; ahol egy lépést a csomag
parancsa végez, ott a K teszt jelölve)*

### 10.1 Amit az app kér

Környezetenként egy kérés (pl. `<app>` az éleshez és `<app>-dev` a fejlesztéshez, külön kulcsokkal):

| Adat | Mit jelent |
| --- | --- |
| app-név | biztonságos szegmens, nem `_`-sal kezdődik (6. pont); egyben a linkek első útvonal-szegmense |
| originök | a médiát betöltő oldalak pontos originje (`https://host[:port]`), a CORS-hoz (5. pont); `*` nem |
| CORP | `same-site` (alapérték), `cross-origin` (az oldal más site-on van, mint a médiaszerver) vagy `same-origin` |
| séma | `kid`-enként HS256 vagy ES256 (2. pont); új appnak az ES256 ajánlott, mert a regisztráción titok nem halad át |
| tartalomkulcs | kell-e `_content/`-letöltés (2.1) |
| feltöltés | kell-e; ha igen, az app ed25519 nyilvános ssh-kulcsa (10.3) |
| leghosszabb link | a `MEDIA_URL_MAX_TTL` (9. pont); a kulcsforgatás átfedése ehhez igazodik (7. pont) |
| méret | a várható tárhely és forgalom (a korlátokhoz, 5. pont) |
| ES256-nál | a `kid`, a fajta (böngészős vagy tartalom) és a nyilvános kulcs, a `media-keys --keypair` kimenetéből |

ES256-nál a kulcspárt **az app generálja**: `media-keys --keypair <app> [--content] [--kid <id>]`. A kimenet két
része: a backend env-sorai (a titkos kulccsal; ezek az appnál maradnak) és „Az üzemeltetőnek küldendő” blokk (app,
`kid`, fajta, nyilvános kulcs, az ellenőrző jelek – a nyilvános kulcs első és utolsó 8 jele –, és az üzemeltető
`--register` parancsa). Az app csak ez utóbbit küldi el. Fájlt nem ír. (K: „parse-olható kimenet: env-sorok (titok)
és az üzemeltetői sor…”: az üzemeltetői blokkban nincs titkos kulcs.)

### 10.2 Amit az üzemeltető visszaad

- **Mindkét sémánál:** az alap-URL (`MEDIA_SERVER_URL`), az app-név (`MEDIA_SERVER_APP`), a `kid`(ek) fajtával és
  sémával, a beállított originök és CORP visszaigazolása. Az üzemeltető az `apps.json`-t (6. pont: `dir`, `origins`,
  `corp`, kulcsok) frissíti és cseréli (7. pont).
- **HS256:** az üzemeltető generálja a kulcsot (`media-keys <app> [--content] --kid <id> --write <apps.json>`; a
  kimenet a 9. pont env-sorait is adja, K: „--write: hozzáad és kiírja…”), és a 10.4 csatornáján átadja a
  böngészős (`MEDIA_SERVER_KEY_ID`, `MEDIA_SERVER_KEYS`) és, ha kérték, a tartalom-`kid`-et és -kulcsot
  (`MEDIA_SERVER_CONTENT_KEY_ID`, `MEDIA_SERVER_CONTENT_KEY`).
- **ES256:** az üzemeltető a kapott nyilvános kulcs ellenőrző jeleit egy második csatornán egyezteti az appal, majd
  felveszi: `media-keys --register <app> --kid <kid> --public-key <87 jel> [--content] --write <apps.json>`. A
  `--register` ugyanazokat az ellenőrző jeleket írja ki, meglévő `kid`-et vagy kulcsot nem ír felül (K: „hozzáad
  (publicKeys / contentPublicKeys)…; kid-ütközésre hiba”). Kulcsanyagot nem ad vissza, csak a visszaigazolást
  (`kid`, ellenőrző jelek). ES256-os próbalinket csak az app tud aláírni (az üzemeltető `media-sign --apps`-a érthető
  hibát ad; K: „--apps módban egy ES256 kid-re érthető hiba”).
- **Feltöltéshez:** a 10.3 adatai.

### 10.3 Feltöltési hozzáférés

- Az app **maga generál** egy ed25519 kulcspárt (pl. `ssh-keygen -t ed25519 -C media-upload-<app>`), és csak a
  nyilvános kulcsot (`.pub`) küldi el; a titkos kulcs nem hagyja el az appot.
- Az üzemeltető a feltöltő felhasználó `authorized_keys`-ébe a 8. pont korlátozott sorát teszi, a saját
  `<médiagyökér>`-jével és az app `dir`-jével (helyőrzők nélkül), és létrehozza az app könyvtárát.
- Visszaadja: a hosztot, az ssh-felhasználót, a hoszt-kulcs ujjlenyomatát (`ssh-keygen -lf`), az rsync célját
  (`<felhasználó>@<host>:`, útvonal nélkül: az rrsync gyökere az app könyvtára), és a telepített sor leírását. Az app
  az első kapcsolódáskor az ujjlenyomatot egyezteti.
- A feltöltő beállításainak (host, kulcsfájl) nevét a SPEC nem írja elő; a feltöltés szabályai a 8. pontban.

### 10.4 Csatorna

- Titok (HS256-kulcs) csak végponttól végpontig titkosított csatornán megy át (pl. egy jelszókezelő megosztott tétele,
  vagy a címzett nyilvános kulcsára titkosított fájl); nyílt e-mailben, chatben, jegykezelőben és repóban **nem
  szabad**.
- A nyilvános kulcsok (ES256, ssh) nem titkok, de a hitelességük számít: egy második, független csatornán egyeztetendők
  (ES256: az első és utolsó 8 jel; ssh: az ujjlenyomat).
- Az üzemeltető naplózza: dátum, app, `kid`, fajta, séma, az ellenőrző jelek; a kulcsot soha.

### 10.5 Az app env-je és a próba

Az app a kapott értékeket a 9. pont neveire képezi. Egy `.env` HS256-tal (a `MEDIA_URL_MAX_TTL` az app saját
beállítása):

```
MEDIA_SERVER_URL=https://media.example.com
MEDIA_SERVER_APP=demo
MEDIA_SERVER_KEY_ID=2026a
MEDIA_SERVER_KEYS='{"2026a":"<kulcs>"}'
MEDIA_SERVER_CONTENT_KEY_ID=2026c
MEDIA_SERVER_CONTENT_KEY=<kulcs>
MEDIA_URL_MAX_TTL=86400
```

ES256-tal a kulcssorok helyett (a `media-keys --keypair` ezeket írja ki): `MEDIA_SERVER_KEY_ID=2026e`,
`MEDIA_SERVER_PRIVATE_KEYS='{"2026e":"<PKCS#8 DER base64url>"}'`, tartalomhoz `MEDIA_SERVER_CONTENT_KEY_ID=2026f` és
`MEDIA_SERVER_CONTENT_PRIVATE_KEY=<…>`. Egy app a két sémát egyszerre is használhatja (pl. forgatás közben, 7. pont).

**Próba:** az app feltölt egy próbafájlt (8. pont), és a saját env-jéből aláír egy linket, `apps.json` nélkül:

```
media-sign --env-file .env <assetKey>                          # böngészős link
media-sign --env-file .env _content/<v>.json.gz --content      # tartalomlink, ha van tartalomkulcs
curl -sI '<url>'                                               # 200 kell
```

A regisztráció kész, ha a próbalink `200`-at ad, és az app ezt visszaigazolta. `403` esetén a `kid`, a kulcs vagy
az app-név nem egyezik (az üzemeltető a naplóban látja az okot: `unknown-app`, `unknown-kid`, `wrong-scheme`,
`bad-signature`; 4. pont), `404` esetén a fájl hiányzik vagy nem kiszolgálható (3. pont). (K: „App-regisztráció,
próbalépés: a --env-file linkje a hamis szerveren 200 (HS256 és ES256, böngészős és tartalom)”; „media-sign --env”
blokk: a kulcs nem kerül a kimenetbe és a hibaüzenetbe.)

### 10.6 Kivezetés

Az app kéri, vagy az üzemeltető határidővel jelzi. Az üzemeltető törli az app bejegyzését az `apps.json`-ból és a
feltöltő sorát, majd cseréli az `apps.json`-t (7. pont); utána az app minden linkje `403 unknown-app`. Az app
könyvtára a megbeszélt határidőig megmarad, utána törlődik. Az app törli a kulcsokat az env-jéből.
