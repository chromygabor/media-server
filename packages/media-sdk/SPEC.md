# A védett médiaszerver protokollja (SPEC)

Ez a leírás **normatív**: a médiaszerver (`server`: nginx + njs) és a `@chromygabor/media-sdk` ennek felel meg.
A döntések indoklása a tervekben van (a terv 4. és 7.1);
ha a terv és ez a leírás eltér, ez az irányadó. A kulcsszavak: **kell** / **nem szabad** (kötelező), **ajánlott**.

Minden állítás mögött zárójelben a teszt, amely fedi (a kiemelésig a monorepó útvonalaival):

| Jel | Teszt |
| --- | --- |
| **V** | `test-vectors.json` közös vektorai: a TS (`src/vectors.spec.ts`), az njs Node alatt (`server/test/njs.spec.ts`) és az njs a konténer CLI-jén, `njs` és `QuickJS` motorral (`media.docker.spec.ts` „a közös vektorok…”); a `verify` vektoroknál a `status` és a `reason` is egyezik |
| **T** | a csomag saját tesztjei: `src/token.spec.ts`, `src/path.spec.ts`, `src/expires.spec.ts`, `src/token.property.spec.ts` |
| **N** | `server/test/njs.spec.ts` (njs Node alatt: TS-paritás fast-checkkel, `validateApps`, js_set-kimenetek, fejlécszűrő) |
| **C** | `server/test/config.spec.ts` (konfigfájlok összhangja) |
| **D** | `server/test/docker/media.docker.spec.ts` (a futó konténer HTTP-n) |
| **K** | `server/test/cli.spec.ts` (kulcsgenerálás, próbalink) |
| **P** | a fogyasztó feltöltő eszközének tesztjei |

A teszt nélküli állítás jelölése: *(teszt nélkül)*. Minden idő unix-másodperc.

## 1. URL-alak

```
<alap-URL>/bcdn_token=HS256-<sig>&kid=<kid>&token_path=<kódolt előtag>[&u=<u>]&expires=<n>/<app>/<assetKey>[?…]
```

- Az első szegmens `/bcdn_token=`-nel kezdődik, a következő `/`-ig tart; utána a kért útvonal (`path`). (V, T)
- A szegmensben `&`-rel: elöl a `bcdn_token`, a végén az `expires`, köztük csak a `kid`, a `token_path` és az
  `u`, mindegyik legfeljebb egyszer; a `kid` és a `token_path` kötelező. Más paraméter `unknown-param`, ismétlés
  `duplicate-param`, hiány `missing-param`. (V, T)
- A köztes paraméterek sorrendje az ellenőrzésnél nem kötött; aláíráskor kulcs szerint rendezve írjuk ki
  (`kid`, `token_path`, `u`). (T: „a paraméterek sorrendje nem kötött”)
- Az értékek **kanonikusan** kódoltak: `encodeURIComponent(érték) === nyers`, üres érték nincs; különben
  `malformed-param`. A `token_path` kódolt (`/` → `%2F`). (V: „nem kanonikus kódolás”, „kódolatlan token_path”; T)
- `token`: `HS256-` + pontosan 43 Base64URL-jel (`[A-Za-z0-9_-]`, kitöltés nélkül); más `malformed-token`. Az
  IP-kötés `HS256-1-` alakja nem elfogadott. (V: „csonka token”, „IP-kötés jelzője”; T)
- `expires`: `0` vagy vezető nulla nélküli, legfeljebb 12 jegyű decimális szám; más `malformed-expires`. (V, T)
- `kid` és `u`: `[A-Za-z0-9._-]{1,128}`; más `malformed-param`. (T; N: fast-check paritás)
- A query (`?…`) figyelmen kívül marad, az ellenőrzésben és a kiszolgálásban sem számít (a `?v=` gyorsítótár-törő
  így szabadon hozzáfűzhető). (V: „a query figyelmen kívül marad”, „hiányzó token, a query-ben adva”)
- A szerver a **nyers** kérés-URI-ból dolgozik (nginx `$request_uri`), nem a dekódolt `$uri`-ból. (D: `%2F`, `%2e%2e`,
  `//` esetek; C: a host-nginx `proxy_pass` URI-rész nélkül)

## 2. A token

```
token        = "HS256-" + Base64URL(HMAC-SHA256(kulcs, token_path + expires + signing_data))
signing_data = "kid=<kid>&token_path=<token_path>[&u=<u>]"      (rendezett, kódolatlan értékek)
```

- A Bunny V2 directory-token algoritmusa, IP nélkül, a mi két paraméterünkkel (`kid`, `u`). A két Bunny-forrású
  aláírási vektor bájtra egyezik a Bunny hivatalos Node-példájának kimenetével. (V: `source: bunny-official-nodejs@…`)
- A HMAC kulcsa a kulcs **szövege** UTF-8 bájtokként; az `apps.json` base64(url)-szövegét **nem szabad** dekódolni.
  (V: a `sign` vektorok kulcsa base64-szöveg; T)
- `u` nélkül a `signing_data`-ban nincs `&u=`. (T: „u nélkül nincs u=”)
- Base64URL: `+` → `-`, `/` → `_`, a záró `=` elhagyva. (T: „base64url”)
- Az aláírás ellenőrzése **időállandó** összehasonlítással történik. (teszt nélkül: az időállandóság; T csak az
  eredményt nézi)

### 2.1 Két tokenfajta

| | Böngészős token | Tartalomtoken |
| --- | --- | --- |
| Kulcs | `apps[app].keys[kid]` | `apps[app].contentKeys[kid]` |
| Útvonal | nem `_`-os (1. app utáni szegmens nem `_`-sal kezdődik) | `/<app>/_content/<név>.json.gz` |
| `token_path` | `/<app>/…/` könyvtár, **`/`-re végződik** | **pontosan** a kért fájl |
| `u` | ajánlott (belső felhasználó-azonosító; napló, kapcsolatkorlát) | **nem szabad** (`u-not-allowed`) |
| Lejárat | a hívó dönti (ajánlott: `min(a felhasználó tokenjének exp-je, most + 24 óra)`) | rövid (ajánlott: 5 perc) |

(V: „helyes könyvtár-token”, „helyes tartalomtoken”, „_content/ böngészős kulccsal”, „böngészős útvonal
tartalomkulccsal”, „tartalomtoken könyvtár-token_path-szal”, „tartalomtoken u-val”; D: „_content/” blokk.
A lejárati ajánlások: teszt nélkül.)

- A `token_path` szabálya (az aláírás **után** nézve): `/<app>/`-pal kezdődik, ahol `<app>` a kért útvonal első
  szegmense (`token-path-app`); biztonságos szegmensekből áll (`token-path-shape`); böngészős tokennél `/`-re végződik,
  tartalomtokennél egyenlő a kért úttal (`token-path-shape`); a kért út előtagja (`outside-token-path`). A `/`-re
  végződő előtag könyvtárat jelent: a `…/ch-01-l0/` nem fedi a `…/ch-01-l01/…`-et. (V: „szomszéd-előtag” esetek,
  „token_path másik appé”, „token_path a gyökér”, „token_path ..-tal”; T: `isPrefixOf`; D: „token_path-on kívül”)
- A `u` nem titok (olvasható), de aláírt: módosítása `bad-signature`. (V: „u módosítva”; D: „módosított u”)
- A `kid` egyben a sémaváltás helye: új formátum = új `kid` (külön verzió-paraméter nincs). (teszt nélkül)
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
  `_`-sal kezdődik; mélyebb `_`-os szegmens nem számít *(ez teszt nélkül)*. Más `_`-os könyvtár, `_content/`
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
| 5 | `kid` a fájlhoz illő kulcsfajtában | `403` | `unknown-kid` (egyikben sincs), `wrong-key-kind` (a másikban van) |
| 6 | HMAC | `403` | `bad-signature` |
| 7 | `token_path` (2.1) | `403` | `token-path-app`, `token-path-shape`, `u-not-allowed`, `outside-token-path` |
| 8 | lejárat: lejárt, ha `now > expires` | `410` | `expired` |
| 9 | a fájl létezése (nginx) | `404` | — |

(V: minden `reason` legalább egy vektorral, köztük „404 a token előtt”, „lejárt, de rossz aláírás → 403”, „lejárat
pillanatában még érvényes”, „kid = constructor”, „app = constructor”; N: a TS és az njs `status`-a és `reason`-je
véletlen bemeneten is azonos; T: „410 csak hiteles tokenre”, „a kulcskereső saját mezőt néz”, „üres kulcs nem kulcs”;
D: „elutasítás” blokk, „nem létező fájl érvényes tokennel → 404”)

- A `410` csak hiteles tokenre jár: a hamis, lejárt link `403`. (V, T, D)
- A `404` (3. lépés) a token előtt jön: a tábla nyilvános, nem szivárogtat. (V)
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
| felhasználónkénti / appenkénti kapcsolatkorlát túllépve | `503` (D: „limit_conn”; az appenkénti: teszt nélkül) |

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
  "elearning": {
    "dir": "elearning",
    "keys":        { "2026a": "<legalább 43 jeles base64(url)>" },
    "contentKeys": { "2026c": "<…>" },
    "origins": ["https://elearning.example"],
    "corp": "same-site"
  }
}
```

| Mező | Szabály |
| --- | --- |
| app-név | biztonságos szegmens, nem `_`-sal kezdődik; legalább egy app kell |
| `dir` (kötelező) | `.` vagy biztonságos szegmensekből álló relatív út; a fájl: `/srv/media/<dir>/<assetKey>` (`.` → `/srv/media/<assetKey>`); több app osztozhat egy `dir`-en |
| `keys`, `contentKeys` (kötelező objektumok, lehetnek üresek) | `kid` → kulcs; `kid`: `[A-Za-z0-9._-]{1,128}`; kulcs: `^[A-Za-z0-9+/_-]{43,}={0,2}$`; egy appon belül a két `kid`-halmaz diszjunkt |
| `origins` (elhagyható) | tömb, elemei `http(s)://host[:port]` útvonal és záró `/` nélkül; `*` nem |
| `corp` (elhagyható) | `same-site` (alapérték), `same-origin` vagy `cross-origin` |

(N: „validateApps” blokk, „dir \".\" → a fájl közvetlenül a /srv/media alatt”, „böngészős token u-val: … fájl a dir
alatt”; D: „másik app saját linkje”, „`dir: \".\"` app”. A közös `dir`: teszt nélkül.)

- Kulcs generálása: 32 véletlen bájt base64url-szövege (43 jel). (K: „keys:new”) Parancs: `pnpm media-server:keys`
  (WP33 után a csomag `media-keys` parancsa).
- A kulcs titok: **nem szabad** repóba, naplóba, hibaüzenetbe kerülnie. (D: a napló nem tartalmazza a kulcsokat; C: a
  `.env.example`-ben nincs kulcs; a CLI-ké: teszt nélkül)

## 7. Kulcsforgatás

Appenként és kulcsfajtánként független. *(teszt nélkül: a menet; a több `kid` egyidejű érvényessége abból következik,
hogy a kulcsot a `kid` választja ki – V: „rossz kid”)*

1. Új `kid` + kulcs az `apps.json`-ba (a régi marad), feltöltés, reload (`deploy`).
2. Az aláíró (a backend) ráválta az új `kid`-re.
3. A régi `kid` törölhető, amikor a vele kiadott leghosszabb link is lejárt (böngészős: a backend `MEDIA_URL_MAX_TTL`-je;
   tartalom: pár perc); újra feltöltés + reload.

Vészhelyzetben a régi kulcs azonnal törölhető: az app minden kiadott linkje `403`, a kliensek újat kérnek; a többi
app érintetlen.

## 8. Feltöltés

A szerver a fájlokat a `dir` alól, csak olvasva adja; a feltöltés rsync ssh-n. A szerződés (a referencia-implementáció
a fogyasztó feltöltő eszköze):

- Appenként egy **korlátozott ssh-kulcs** a szerver felhasználójának `authorized_keys`-ében, amely csak `rrsync`-et
  enged, csak az app könyvtárába; az rsync célja az rrsync gyökere, útvonal nélkül (`<host>:`). *(teszt nélkül;
  a sor alakja: `server/README.md` „Feltöltő kulcs és új app”)*

  ```
  restrict,command="/usr/bin/rrsync -munge /srv/media-server/data/<dir>" ssh-ed25519 AAAA… media-upload-<app>
  ```

- Jogosultság a célon: `--chmod=D755,F644` (a konténer olvashassa). (P: „push: -rt --checksum --chmod”, valódi rsync)
- A megszakadt átvitel a `.rsync-partial/` alá kerül (`--partial-dir`); a szerver a `.`-tal kezdődő szegmenst nem
  szolgálja ki (`403 unsafe-path`). (P: `pushArgs`, `uploadArgs`; V: „.-tal kezdődő fájl”, „. szegmens”; D: „.-tal
  kezdődő fájl”)
- A médiafeltöltés (push) nem visz fel `*.build.json`-t, `*.part*`-ot, `.`-os fájlt és a gyökér `_content/`-jét,
  és **nem szabad** `--delete`-tel futnia. (P: „a kizárások”, „soha nincs --delete”, „többletfájl megmarad”)
- A `_content/` a tartalomkiadás helye: `<v>.json.gz`, utána a `<v>.json.gz.sha256` kísérőfájl, `--ignore-existing`-gel
  (meglévő kiadás nem íródik felül). (P: `uploadArgs`; `contentPublishRemote.spec.ts`)
- Törlés (prune) csak külön lépésben; a `_content/` egésze és minden `.`-os bejegyzés **védett** (`P /_content/***`,
  `P .*`). (P: `mediaPrune.spec.ts` „a _content/ és a .-os bejegyzések védettek”, „--apply: … maradnak”)

## 9. Ajánlott backend env-nevek

Konvenció, nem kötelező (a `pnpm media-server:keys` ezeket írja ki). *(teszt nélkül a csomag szintjén; a fogyasztó
backend env-sémájának tesztje)*

| Név | Jelentés |
| --- | --- |
| `MEDIA_SERVER_URL` | a médiaszerver alap-URL-je (élesben `https://`) |
| `MEDIA_SERVER_APP` | az app neve az `apps.json`-ban |
| `MEDIA_SERVER_KEYS` | böngészős kulcsok, JSON: `{ "<kid>": "<kulcs>" }` |
| `MEDIA_SERVER_KEY_ID` | az aláíráshoz használt böngészős `kid` (szerepel a `MEDIA_SERVER_KEYS`-ben) |
| `MEDIA_SERVER_CONTENT_KEY_ID`, `MEDIA_SERVER_CONTENT_KEY` | a tartalomkulcs (ha az app tölt le `_content/`-et) |
| `MEDIA_URL_MAX_TTL` | a böngészős link leghosszabb élettartama másodpercben (ajánlott `86400`) |
