# @chromygabor/media-server

Védett médiaszerver – a **termék**: saját image (`Dockerfile`: a hivatalos `nginx` image tagre és digestre rögzítve, njs 1.0.2,
benne a konfig és az njs) + egy njs-modul, amely a
Bunny V2 directory-tokent (`kid`, `u` kiegészítéssel; `HS256-`) és a médiaszerver saját aszimmetrikus sémáját
(`ES256-`, ECDSA P-256, az app saját kulcspárja) ellenőrzi, és az nginx statikus motorjával szolgál ki (Range, ETag,
sendfile). A protokoll normatív leírása: [`../packages/media-sdk/SPEC.md`](../packages/media-sdk/SPEC.md).
A telepítés (generikus compose, `.env`-minta, host-blokk, `deploy.sh`, üzemeltetői kézikönyv) a
[`../deploy/`](../deploy/README.md) alatt van; egy konkrét célgép adatai a gitignore-olt `deploy/<cél>/` alatt.
Ügyfél-appból nem importál; a tesztek a `@chromygabor/media-sdk`-t használják, a kulcsgenerálás és a
próbalink-aláírás a csomag `media-keys` / `media-sign` parancsa (a gyökér `pnpm keys` / `pnpm sign` hívja).

```
Dockerfile                a rögzített nginx-digestből; COPY nginx/ (+ templates/) és njs/; CMD nginx -c …/media/nginx.conf
.dockerignore             pozitív lista: csak a konfig és az njs kerül a build-kontextusba
compose.yaml              CSAK helyi futtatás és teszt: build: ., egy szolgáltatás (media), read_only, 127.0.0.1:10090,
                          rögzített alhálózat (real_ip); csak az apps.json és a médiagyökér csatolt
nginx/nginx.conf          njs-modul, types-tábla, real_ip, js_preload_object apps, js_shared_dict_zone (hibaszámláló)
nginx/media.conf          kapu (js_content + js_var-ok → @serve), limit_*, @denied / @notfound / @gone / @toomany,
                          JSON-napló (token nélkül), /healthz
nginx/templates/          realip.conf.template (az image envsubst-je: set_real_ip_from ${NET_GATEWAY})
njs/media.js              token-ellenőrzés (= media-sdk verifySignedPath: status ÉS reason; HS256 és ES256), a kapu
njs/check-apps.js         az apps.json tartalmi ellenőrzése a konténerben (njs CLI), a nyilvános kulcsok görbéje is
scripts/image-build.sh    image-építés: media-server:<verzió>-<SHA> + OCI-címkék (pnpm image:build), lásd Image
scripts/make-test-video.sh   szintetikus mintamédia (ffmpeg): pnpm dev-media, és a próbafájlok a telepítéshez
secrets/                  gitignore-olt (apps.local.json; egy célgépé a ../deploy/<cél>/secrets/ alatt)
test/                     docker nélküli tesztek (pnpm test; a deploy.spec.ts a ../deploy/-t is nézi);
                          fixtures/apps.test.json: CSAK TESZT kulcsok
test/docker/              docker-integrációs teszt az image-en (pnpm test:docker), lásd alább
```

## Kérés útja (terv 4.4; a kapu: aszimmetrikus terv 4., D112)

Nyers `$request_uri` → alak (`403`) → kiterjesztés-tábla (`404`) → app, `kid`, kulcsfajta, séma (`wrong-scheme`),
aláírás (HMAC, illetve ES256 low-S + ECDSA), `token_path` (`403`) → lejárat (`410`) → fájl (`404`) → `200`/`206`.
A séma a `kid`-ből jön (`keys`/`contentKeys` → HS256, `publicKeys`/`contentPublicKeys` → ES256), soha nem a tokenből.

Szerkezet: a fő location `js_content`-je (`media.gate`) aszinkron ellenőriz, a döntést `js_var`-okba írja
(`$media_status`, `$media_reason`, `$media_file`, `$media_app`, `$media_kid`, `$media_u`, `$media_user_key`,
`$media_kind`), és sikernél a `@serve`-be irányít (`limit_conn`, `limit_rate`, `try_files`, fejlécszűrő); hibánál
törzs nélküli `403`/`404`/`410`/`429` → `error_page` → `@denied`/`@notfound`/`@gone`/`@toomany`. Az `OPTIONS` (`204`)
és a `405` a fő location-ben marad. A válasz törzse minimális (`forbidden` / `not found` / `expired` /
`too many requests`); az ok (`reason`) csak a JSON-naplóban. Érvénytelen tokenre IP-nként ~10 r/s (`429` fölötte,
a `@denied` `limit_req`-je); `limit_conn` felhasználónként 3, appenként 40; `limit_rate_after 30m`, `limit_rate 600k`.

**Hibaszámláló (D116):** aszimmetrikus `kid`-re IP-nként 50 hibás aláírás / 10 s után az IP ES256-kérései az
aláírás-ellenőrzés előtt `429`-et kapnak (`reason: blocked`, csak a naplóban), a lejáratig (az első hibától 10 s). A
küszöb és az ablak njs-konstans (`FAILS_LIMIT`, `FAILS_WINDOW_MS`), a zóna a `js_shared_dict_zone media_fails`. A
HMAC-kérésekre nem hat (sem a számlálás, sem a blokk). Az nginx-modul az Ed25519-et nem ismeri (D111); ezt a
docker-teszt kanárija figyeli.

## Kulcsok

- A kulcs **32 véletlen bájt base64url-szövege** (43 jel). A HMAC kulcsa ez a **szöveg UTF-8-ként** (ahogy a
  Bunny is használja); az `apps.json` értékét senki nem dekódolja. Az njs legalább 43 jeles base64(url) szöveget
  fogad el.
- `pnpm keys <app> [--content] [--kid <id>] [--write <apps.json>] [--dir <könyvtár>]` – kiírja az
  `apps.json`-részletet és a backend-oldali (MS2) értéket (a csomag `media-keys` parancsa, munkakönyvtár:
  `server/`); `--write` csak hozzáad (meglévő `kid`-et nem ír felül),
  helyben ír (ugyanaz az inode), új fájlt `0600`-zal hoz létre, a meglévő jogosultságát megtartja.
  Az `apps.json` egy fájlként van csatolva: ha egy szerkesztő új fájlt (új inode-ot) ír helyette, a futó konténer
  a régit látja – ilyenkor `docker compose restart media` kell, nem elég a reload (a szerveren:
  `pnpm server:deploy --reload-config`, amely ezt magától eldönti).
- Az `apps.json` tartalmi hibáját az nginx konfigtöltéskor nem látja (csak a JSON-szintaxist): reload előtt
  `docker compose exec -T media njs -q -m -p /etc/nginx/njs /etc/nginx/njs/check-apps.js`. Hibás `apps.json`
  mellett minden kérés `403` (`reason: apps-invalid`). A `check-apps.js` a nyilvános kulcsok görbéjét is nézi; egy
  görbén kívüli kulcs `kid`-jére a szerver kérésidőben `403 internal-error`-t adna.
- **ES256 (aszimmetrikus) `kid`:** az app generálja a kulcspárt (`media-keys --keypair`), az üzemeltetőhöz csak a
  nyilvános kulcs (87 jel, tömörítetlen P-256 pont) jön; az első és utolsó 8 jelét egy második csatornán egyeztetni
  kell. Felvétel: `pnpm keys --register <app> --kid <kid> --public-key <kulcs> [--content] --write
  <apps.json>` (`publicKeys`/`contentPublicKeys`; a négy `kid`-halmaz appon belül diszjunkt, meglévő `kid`-et nem ír
  felül). Az üzemeltető ilyen `kid`-hez nem tud próbalinket aláírni: azt az app adja (`media-sign --env-file`).
- **Visszaállás (rollback) és az új mezők:** a WP52 előtti njs és nginx-konfig a `publicKeys`/`contentPublicKeys`
  mezőket figyelmen kívül hagyja (a `validateApps` nem tiltja a nem ismert mezőt). Kipróbálva 2026-11-24: a régi
  `nginx/` + `njs/` a vegyes `test/fixtures/apps.test.json`-nal `nginx -t` és `check-apps.js` rendben, a HMAC-link
  `200`, az ES256-link `403 malformed-token`.

## Helyi futtatás

A szerver a saját, generált szintetikus mintamédiájával fut (ügyfél-tananyag nélkül). Előfeltétel: Node ≥ 22, pnpm,
docker + `docker compose`, ffmpeg; a repó gyökerében egyszer `pnpm install` és `pnpm build` (a `keys`/`sign` a
csomag lefordított parancsait hívja).

A `pnpm` parancsok a repó gyökeréből, a `docker compose` a `server/`-ből fut. Az `apps.local.json` a `docker compose up`
előtt kell: hiányában a docker egy root tulajdonú könyvtárat hoz létre a helyén.

```
pnpm dev-media                             # server/dev-media/: 1 perces MP4, M4A, JPG, _content/, a `demo` és a `proba` app (gitignore-olt)
cp server/.env.example server/.env         # MEDIA_ROOT=./dev-media (csak olvasva), APPS_JSON=./secrets/apps.local.json
pnpm keys demo --kid dev1 --write secrets/apps.local.json >/dev/null   # az útvonal a server/-hez képest; a stdout a kulcsot is kiírja
cd server
docker compose up -d --build --wait        # az image a Dockerfile-ból (media-server:dev); /healthz → 204
pnpm -w --silent sign demo proba-tema/lessons/ch-01-l01/m01.720p.mp4   # --u <uuid>, --content, --ttl=<mp>, --prefix, --kid, --base
docker compose exec -T media nginx -c /etc/nginx/media/nginx.conf -t           # a konfig a -c-vel érhető el
docker compose exec -T media nginx -c /etc/nginx/media/nginx.conf -s reload   # új apps.json-tartalom (ugyanaz az inode)
docker compose up -d --build --wait        # nginx/ vagy njs/ változása után: új image, új konténer
docker compose logs -f media               # JSON-napló, token nélkül
docker compose down
```

A `pnpm keys` és a `pnpm sign` relatív útvonalai (`--write`, `--apps`) a `server/`-hez
képest értendők; a `pnpm sign` alapból a `secrets/apps.local.json`-ból ír alá (egy `--apps` felülírja). Negatív `--ttl` csak `=`-vel
(`--ttl=-10`).

## Docker-integrációs teszt

`pnpm test:docker` (= `pnpm --filter @chromygabor/media-server test:docker`; a sima `pnpm test` nem futtatja).
**Az image-et teszteli, nem a munkapéldány fájljait:** a `MEDIA_IMAGE`-ben megadott kész image-et indítja (a deploy így
a kiadási címkét teszteli), ennek hiányában előbb a `scripts/image-build.sh --tag media-server:dev`-vel épít; a konfig
és az njs nincs csatolva (egy eset ellenőrzi, hogy a futó konténer a tesztelt image, csak az `apps.json` és a
médiagyökér csatolásával). `MEDIA_DOCKER_REQUIRED=1` mellett (deploy, CI) a hiányzó docker vagy ffmpeg hiba, nem kihagyás.
A `test/docker/setup.ts` a `test/.tmp/docker-*/root` alá szintetikus teszt-gyökeret ír (ffmpeg-gel generált 2 s-os
MP4 / M4A / JPG, magolt bináris, ritka 40 MiB-os fájl, szintetikus `_content/<v>.json.gz`; valódi tananyag nem), és
a konténert egyedi projektnévvel (`media-server-test-<pid>-<rand>`), szabad loopback-porttal és szabad
`172.29.<n>.0/24` alhálózattal indítja a `test/fixtures/apps.test.json` kulcsaival; a végén `down -v`, és az
ideiglenes könyvtár törlődik. Docker (futó démon), `docker compose` vagy ffmpeg hiányában a spec üzenettel kihagy.
Megszakított futás után a maradék: `docker compose ls` → `docker compose -p <név> down -v`, `rm -r test/.tmp`.
A fixture vegyes (HMAC- és ES256-`kid`-ek az `elearning` appnál): a HMAC-esetek változatlanok, az ES256-esetek (`200`,
`206`, `416`, `304`, tartalom, `wrong-scheme`, magas-S, CORS, napló, `limit_conn`, hibaszámláló a lejárattal) külön
blokkban; a `check-apps.js` és az `nginx -t` egy HMAC-only változatra is fut; a közös vektorok (az `es256.verify`
is) mindkét motoron; a kanári (Ed25519 a modulban) egy ideiglenes második nginx-szel a konténerben (`127.0.0.1:18099`).
A hibaszámláló lejárat-tesztje miatt a futás ~10 s-mal hosszabb.

## Image

```
pnpm image:build                     # = server/scripts/image-build.sh → media-server:<verzió>-<rövid SHA>
pnpm image:build --allow-dirty       # piszkos munkafánál: media-server:<verzió>-<SHA>-dirty-<UTC időbélyeg>
bash server/scripts/image-build.sh --tag media-server:dev   # tetszőleges címke (helyi futtatás, teszt)
```

- Alap: a `nginx:1.30.7-alpine@sha256:caf4e1e0…` (tag + digest rögzítve; emelés: új digest a `Dockerfile`-ban, a teljes
  docker-teszt és a kanári zöldje után). A `CMD` és az env-alapértékek (`NGINX_ENVSUBST_*`, `NET_GATEWAY`) a
  `Dockerfile`-ban; a konfig `/etc/nginx/media/`, az njs `/etc/nginx/njs/` alatt, root tulajdonban, `0644`/`0755`.
- Futáskor kívülről: `/etc/nginx/secrets/apps.json` és `/srv/media` csak olvasva, `read_only` gyökér, `tmpfs` a
  `/etc/nginx/conf.d`, `/var/cache/nginx`, `/run`, `/tmp` alá, `NET_GATEWAY` a compose alhálózatának átjárója.
- OCI-címkék: `org.opencontainers.image.revision` (teljes SHA, piszkos fánál `-dirty` végződéssel), `.version` (a
  `server/package.json`-ból), `.source`, `.title`, `.licenses` (`MIT`).
- Regisztry nincs: egy telepítés a kész image-et `docker save | docker load`-dal kapja (lásd
  [`../deploy/README.md`](../deploy/README.md)).

## Telepítések

A termék nem tud a telepítéseiről. A generikus telepítés a repó [`deploy/`](../deploy/README.md) könyvtára: a
`compose.yaml` (a kész image címkéjével, ugyanazzal a keményítéssel, mint a `compose.yaml` itt – a
`test/deploy.spec.ts` ellenőrzi), a `.env`-minta, a host-blokk mintája és a `deploy.sh`. Egy célgép saját adatai
(ssh-cím, felhasználó, könyvtár, az `apps.json` helyi példánya) a gitignore-olt `deploy/<cél>/` alatt élnek:
`pnpm server:deploy <cél>`.
