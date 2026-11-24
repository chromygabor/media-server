# @chromygabor/media-server

Védett médiaszerver: a hivatalos `nginx` image (tag + digest rögzítve, njs 1.0.2) + egy njs-modul, amely a
Bunny V2 directory-tokent (`kid`, `u` kiegészítéssel; `HS256-`) és a médiaszerver saját aszimmetrikus sémáját
(`ES256-`, ECDSA P-256, az app saját kulcspárja; az aszimmetrikus terv, ide nem költözött)
ellenőrzi, és az nginx statikus motorjával szolgál ki (Range, ETag, sendfile). Tervek: a terv 4.1–4.4, 7.2–7.3,
az implementációs terv WP2–WP4.
Ügyfél-appból nem importál; a tesztek a `@chromygabor/media-sdk`-t használják, a kulcsgenerálás és a
próbalink-aláírás a csomag `media-keys` / `media-sign` parancsa (a gyökér `pnpm keys` / `pnpm sign` hívja).

```
compose.yaml              egy szolgáltatás (media), read_only, 127.0.0.1:10090, rögzített alhálózat (real_ip)
nginx/nginx.conf          njs-modul, types-tábla, real_ip, js_preload_object apps, js_shared_dict_zone (hibaszámláló)
nginx/media.conf          kapu (js_content + js_var-ok → @serve), limit_*, @denied / @notfound / @gone / @toomany,
                          JSON-napló (token nélkül), /healthz
nginx/templates/          realip.conf.template (az image envsubst-je: set_real_ip_from ${NET_GATEWAY})
njs/media.js              token-ellenőrzés (= media-sdk verifySignedPath: status ÉS reason; HS256 és ES256), a kapu
njs/check-apps.js         az apps.json tartalmi ellenőrzése a konténerben (njs CLI), a nyilvános kulcsok görbéje is
scripts/make-test-video.sh   szintetikus próbamédia (ffmpeg) az élő elfogadáshoz, lásd Élesítés
secrets/                  gitignore-olt (apps.local.json, apps.prod.json)
test/                     docker nélküli tesztek (pnpm test); fixtures/apps.test.json: CSAK TESZT kulcsok
test/docker/              docker-integrációs teszt (pnpm test:docker), lásd alább
deploy/deploy.sh          telepítés a szerverre (pnpm server:deploy [--dry-run]), lásd Élesítés
deploy/host-nginx.conf.example   a host-nginx media.example.com blokkja (TLS, proxy a 10090-re)
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
  a régit látja – ilyenkor `docker compose restart media` kell, nem elég a reload.
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

```
pnpm dev-media                             # server/dev-media/: 1 perces MP4, M4A, JPG, _content/, a `demo` és a `proba` app (gitignore-olt)
cd server
cp .env.example .env                       # MEDIA_ROOT=./dev-media (csak olvasva), APPS_JSON=./secrets/apps.local.json
pnpm keys demo --kid dev1 --write secrets/apps.local.json
docker compose up -d --wait                # http://127.0.0.1:10090/healthz → 204
pnpm --silent sign demo proba-tema/lessons/ch-01-l01/m01.720p.mp4      # --u <uuid>, --content, --ttl=<mp>, --prefix, --kid, --base
docker compose exec -T media nginx -c /etc/nginx/media/nginx.conf -t           # a konfig a -c-vel érhető el
docker compose exec -T media nginx -c /etc/nginx/media/nginx.conf -s reload
docker compose logs -f media               # JSON-napló, token nélkül
docker compose down
```

A `pnpm keys` és a `pnpm sign` relatív útvonalai (`--write`, `--apps`) a `server/`-hez
képest értendők; a `pnpm sign` alapból a `secrets/apps.local.json`-ból ír alá (egy `--apps` felülírja). Negatív `--ttl` csak `=`-vel
(`--ttl=-10`).

## Docker-integrációs teszt

`pnpm test:docker` (= `pnpm --filter @chromygabor/media-server test:docker`; a sima `pnpm test` nem futtatja).
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

## Élesítés (media-host)

Terv 7.3, implementációs terv WP4. A media-host (`media-host`, felhasználó `deploy`, a `docker` csoport tagja)
host-nginxe (1.24) a TLS-végpont a wildcard tanúsítvánnyal (`*.example.com`); a médiaszerver konténere csak a
loopbacken (`127.0.0.1:10090`) érhető el, a `media.example.com` blokk proxyz rá. A 80-as `00-http` site már
HTTPS-re irányít, oda nem kell semmi.

### Könyvtárfa a szerveren

```
/srv/media-server/                (deploy:docker, 0755; egyszeri sudo-lépés)
  compose.yaml                    a repóból – deploy.sh
  nginx/                          a repóból – deploy.sh (--delete csak ezen belül)
  njs/                            a repóból – deploy.sh (--delete csak ezen belül)
  .env                            csak itt, kézzel (lásd alább); a deploy.sh soha nem írja
  secrets/                        0700
    apps.json                     csak itt, 0400; a deploy.sh soha nem írja
  data/                           MEDIA_ROOT; a deploy.sh soha nem írja
    elearning/                    az appok közös gyökere
    proba/                        a volt próba app gyökere (D13: az app törölve; a könyvtár a WP23-ban törlendő)
```

### Egyszeri sudo-lépések (a tulajdonos)

A host-blokk példánya a szerveren: `~/media-server-host.conf` (= `deploy/host-nginx.conf.example`). Sorrend: előbb a
könyvtár, utána (a konténer első indítása után, hogy ne legyen `502`) a host-blokk. A blokk korábban is élesíthető;
addig a `media.example.com` `502`-t ad.

```
sudo install -d -o deploy -g docker -m 0755 /srv/media-server
sudo install -o root -g root -m 0644 ~/media-server-host.conf /etc/nginx/sites-available/media-site
sudo ln -s /etc/nginx/sites-available/media-site /etc/nginx/sites-enabled/media-site
sudo nginx -t && sudo systemctl reload nginx
```

Visszaállás: `sudo rm /etc/nginx/sites-enabled/media-site && sudo nginx -t && sudo systemctl reload nginx`.

### `.env` és könyvtárak a szerveren (sudo nélkül)

```
ssh media-host 'install -d -m 0700 /srv/media-server/secrets && install -d /srv/media-server/data/<dir>'
ssh media-host 'cat > /srv/media-server/.env' <<'EOF'
MEDIA_ROOT=/srv/media-server/data
APPS_JSON=./secrets/apps.json
BIND=127.0.0.1
PORT=10090
NET_SUBNET=172.29.90.0/24
NET_GATEWAY=172.29.90.1
COMPOSE_PROJECT_NAME=media-server
EOF
```

A `172.29.90.0/24` és a `10090` az alapérték. Ha ütközne, a `.env`-ben a `NET_SUBNET` / `NET_GATEWAY` együtt váltandó (a `real_ip` az átjárót
bízza meg).

### Kulcsok és az `apps.json` a szerveren

A kulcsok a fejlesztőgépen készülnek (a szerveren nincs Node), a gitignore-olt `secrets/apps.prod.json`-ba
(ebből ír alá a `pnpm sign` is), és innen kerülnek fel. Az `apps.json` két példányban él (D12): a fejlesztőgépen
(`secrets/apps.prod.json`, `0600`, gitignore-olt) és a szerveren (`secrets/apps.json`, `0400`); jelszókezelő nincs.
Elvesztése nem adatvesztés: új kulcs + feltöltés + `deploy` + a backend env-je.

Egy app mellé fejlesztői app is felvehető ugyanazzal a `dir`-rel, saját kulcsokkal és a fejlesztői originekkel (D2);
az éles appon nem lazítunk.

```
pnpm keys <app> --kid <kid> --write secrets/apps.prod.json
pnpm keys <app> --kid <kid> --content --write secrets/apps.prod.json
pnpm keys <app>-dev --dir <dir> --kid <kid> --write secrets/apps.prod.json
pnpm keys <app>-dev --kid <kid> --content --write secrets/apps.prod.json
# az origins és a corp kézzel (a pnpm keys alapja: origins [], corp same-site; a dir alapból az app neve)
```

A `pnpm keys` stdout-ja a kulcsot is kiírja: élesben `>/dev/null`-ra irányítandó; a backend env-értéke a helyi
fájlból vehető (`jq -r '.["<app>"].keys' …`).

Feltöltés új fájlként, atomikusan (a régi `0400`-as fájl nem írható felül, és a `mv` új inode-ot ad – a
`deploy.sh` ezt észleli, és `restart`-ot ad):

```
scp server/secrets/apps.prod.json media-host:/srv/media-server/secrets/apps.json.new
ssh media-host 'cd /srv/media-server/secrets && chmod 0400 apps.json.new && mv -f apps.json.new apps.json'
pnpm server:deploy                    # check-apps.js, nginx -t, majd restart (új inode)
```

Nincs más mentés (D12): a két példány elég, a kulcs pótolható.

**Rotáció** (appenként és kulcsfajtánként független, terv 4.3): az új `kid` előbb a szerverre (`pnpm keys … --write`
→ feltöltés → `deploy`), csak utána vált rá az aláíró (MS2-ben a backend env-je; a `pnpm sign`-nál `--kid`). A régi
kulcs a leghosszabb lejárat után törölhető (böngészős: 6 óra, tartalom: 5 perc): a bejegyzés kézzel ki a helyi
fájlból, újra feltöltés + `deploy`. **Új app:** egy `pnpm keys` (új app-névvel), `install -d data/<dir>`, feltöltés,
`deploy` – kód nem változik.

### Feltöltő kulcs és új app

Feltöltés (a fogyasztó feltöltő eszközével) nem külön felhasználóval megy, hanem a `deploy`-ra appenként
egy **korlátozott kulccsal**: a `~/.ssh/authorized_keys` egy sora csak `rrsync`-et enged, csak az app könyvtárába.
A `restrict` kulcsonként tiltja a shellt, a terminált és a továbbításokat; a `deploy` többi kulcsa változatlan.

```
restrict,command="/usr/bin/rrsync -munge /srv/media-server/data/<dir>" ssh-ed25519 AAAA… media-upload-<app>
```

Új app (pl. `masik`) felvétele – sudo, nginx- és kódváltozás nélkül:

1. `mkdir /srv/media-server/data/masik` (a szerveren, `deploy`-ként).
2. Kulcsok az `apps.prod.json`-ba: `pnpm keys masik --kid 2026a --write secrets/apps.prod.json`, tartalomkulcs kell-e:
   `--content --kid 2026c`; kézzel `dir`, `origins`, `corp` (`same-site`, ha `*.example.com` alatt fut).
3. Az `apps.json` felmásolása (`secrets/apps.json`, 0400) és `pnpm server:deploy`.
4. Feltöltő kulcs: `ssh-keygen -t ed25519 -f ~/.ssh/media_upload_masik -N ""`, a fenti sor a saját
   `data/masik` gyökérrel a szerveren a `deploy` `authorized_keys`-ébe (előtte mentés).
5. Az app backendjének env-je: `MEDIA_SERVER_URL`, `MEDIA_SERVER_APP=masik`, `MEDIA_SERVER_KEY_ID`,
   `MEDIA_SERVER_KEYS` (+ `MEDIA_SERVER_CONTENT_KEY_ID`, `MEDIA_SERVER_CONTENT_KEY`).

Kivezetés visszafelé: bejegyzés és kulcssor törlése, deploy, majd a mappa törlése.

### Deploy

```
pnpm server:deploy --dry-run          # előfeltételek + az rsync változáslistája; a szerveren nem változik semmi
pnpm server:deploy                          # = server/deploy/deploy.sh
```

Környezet: `DEPLOY_HOST` (alap `media-host`), `DEPLOY_USER` (`deploy`), `DEPLOY_DIR` (`/srv/media-server`),
`DEPLOY_SSH_OPTS` (`-o BatchMode=yes -o ConnectTimeout=10`). Ha az mDNS kihagy (P16), az IP-vel, a meglévő
host-kulcsra hivatkozva (a `known_hosts` `media-host`-bejegyzése):

```
DEPLOY_HOST=192.0.2.10 DEPLOY_SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -o HostKeyAlias=media-host" pnpm server:deploy
```

Ugyanez a kézi `ssh` / `scp`-nél: `-o HostKeyAlias=media-host deploy@media-host`. Lépések:

1. Előfeltételek: helyben `rsync`, `ssh`, a forrásfájlok; a szerveren a `DEPLOY_DIR` létezik és írható, a `.env` és a
   `secrets/apps.json` megvan és olvasható, a `.env` `APPS_JSON` / `MEDIA_ROOT` útvonala létezik (különben a
   docker root-ként hozná létre a hiányzó könyvtárat), `docker compose` és `curl` elérhető. Hiánynál egyértelmű
   `HIBA:` sor, nem nulla kilépés, a szerveren semmi nem változik.
2. `rsync -rt --checksum --chmod=D755,F644`: a `compose.yaml`, és `--delete`-tel az `nginx/` és az `njs/` – a
   `--delete` csak ezen a két könyvtáron belül hat. A `.env`, `secrets/`, `data/` sosem íródik és nem törlődik.
   A `--checksum` miatt csak a tartalmában változott fájl cserélődik (új inode csak valódi változásnál).
3. A szerveren: `docker compose config -q`; `check-apps.js` és `nginx -c /etc/nginx/media/nginx.conf -t` egy
   eldobható konténerben (`docker compose run --rm`, tehát az új konfiggal és a mostani `apps.json`-nal – a futó
   konténert hiba esetén nem érinti); `docker compose up -d --wait`; ha a konténer nem most jött létre: a
   `compose.yaml` vagy az `apps.json` inode-ja változott → `docker compose restart media`, különben
   `nginx -c … -s reload`; végül `/healthz` → `204`.

### Próbafájlok (csak szintetikus)

A szerverre MS3 előtt csak szintetikus média kerül (valódi tartalom nem része a repónak). A
`scripts/make-test-video.sh` ffmpeg-gel generál (a szerveren nincs ffmpeg, ezért helyben, és `rsync`-kel fel):

```
server/scripts/make-test-video.sh /tmp/media-data          # 44 perces 720p MP4 (~495 MB, +faststart), M4A, JPG,
                                                                     # .build.json, _content/2026.11.23-proba.json.gz, proba/…
rsync -rt --chmod=D755,F644 /tmp/media-data/ media-host:/srv/media-server/data/
```

Útvonalak (`data/` alatt; a szkript 2026-11-24 óta a `demo/` alá ír, az élő elfogadás 2026-11-23-án még az
`elearning/` alá generált, az alábbi a szerveren lévő állapot): `elearning/proba-tema/lessons/ch-01-l01/m01.720p.mp4` (`.audio.m4a`, `.poster.jpg`,
`.720p.mp4.build.json`), `elearning/_content/2026.11.23-proba.json.gz`, `proba/proba-tema/lessons/ch-01-l01/m01.720p.mp4`.
A 44 perces fájl teljes letöltése a `limit_rate_after 30m` / `limit_rate 600k` miatt ~13 perc (szándékos).

### Próbalink

```
pnpm --silent sign <app> <assetKey> --apps secrets/apps.prod.json --base https://media.example.com [--u <uuid>] [--kid <kid>]
pnpm --silent sign <app> _content/<v>.json.gz --content --apps secrets/apps.prod.json --base https://media.example.com
curl -sI '<url>'                            # 200; Range: curl -s -o /dev/null -w '%{http_code}\n' -r 0-99 '<url>' → 206
```

Az app `dir`-je a szerveren `<dir>`, tehát a `<assetKey>` a `data/<dir>/` alatti
relatív útvonal. A `pnpm sign` a `_content/`-et csak `--content`-tel (tartalomkulccsal) írja alá; a szerver a böngészős
kulccsal aláírt `_content/`-kérést `403`-mal utasítja el.

### Hibakeresés

```
ssh media-host
cd /srv/media-server
docker compose ps                                   # állapot, health
docker compose logs --tail 100 -f media             # JSON-napló (app, kid, u, path, status, reason, IP; token nélkül)
docker compose exec -T media nginx -c /etc/nginx/media/nginx.conf -t   # a konfig CSAK a -c-vel érhető el
docker compose exec -T media nginx -c /etc/nginx/media/nginx.conf -T   # a betöltött teljes konfig
docker compose exec -T media njs -q -m -p /etc/nginx/njs /etc/nginx/njs/check-apps.js
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:10090/healthz     # 204
```

- A `nginx -t` / `-s reload` `-c` nélkül az image alapkonfigját nézi, nem a miénket.
- Minden kérés `403`, `reason: apps-invalid` → hibás `apps.json` (a `check-apps.js` megmondja, mi).
- `media.example.com` → `502`: a konténer nem fut, vagy nem a `10090`-on. A host blokkja szándékosan nem
  naplóz (`access_log off`, `error_log … crit`, mert a hibasorban a tokenes kérés-sor is benne volna); a diagnózis a
  konténer naplója és a `/healthz`.
- Az `apps.json` cseréje után a futó konténer a régi fájlt látja (egy fájlként csatolt kötet): `docker compose
  restart media` (a `deploy.sh` ezt magától eldönti).
