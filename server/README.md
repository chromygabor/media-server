# @workspace/media-server

Védett médiaszerver: a hivatalos `nginx` image (tag + digest rögzítve, njs 1.0.2) + egy njs-modul, amely a
Bunny V2 directory-tokent (`kid`, `u` kiegészítéssel) ellenőrzi, és az nginx statikus motorjával szolgál ki
(Range, ETag, sendfile). Tervek: a terv 4.1–4.4, 7.2–7.3,
az implementációs terv WP2–WP4.
Ügyfél-appból nem importál; a CLI-k és a tesztek a `@chromygabor/media-sdk`-t használják.

```
compose.yaml              egy szolgáltatás (media), read_only, 127.0.0.1:10090, rögzített alhálózat (real_ip)
nginx/nginx.conf          njs-modul, types-tábla, real_ip, js_preload_object apps
nginx/media.conf          js_set változók, CORS / CORP / Cache-Control, limit_*, JSON-napló (token nélkül), /healthz
nginx/templates/          realip.conf.template (az image envsubst-je: set_real_ip_from ${NET_GATEWAY})
njs/media.js              token-ellenőrzés (= media-sdk verifySignedPath: status ÉS reason), js_set-kimenetek
njs/check-apps.js         az apps.json tartalmi ellenőrzése a konténerben (njs CLI)
scripts/keys-new.ts       kulcsgenerálás
scripts/sign.ts           próbalink aláírása
scripts/make-test-video.sh   szintetikus próbamédia (ffmpeg) az élő elfogadáshoz, lásd Élesítés
secrets/                  gitignore-olt (apps.local.json, apps.prod.json)
test/                     docker nélküli tesztek (pnpm test); fixtures/apps.test.json: CSAK TESZT kulcsok
test/docker/              docker-integrációs teszt (pnpm media-server:test), lásd alább
deploy/deploy.sh          telepítés a szerverre (pnpm media-server:deploy [--dry-run]), lásd Élesítés
deploy/host-nginx.conf.example   a host-nginx media.example.com blokkja (TLS, proxy a 10090-re)
```

## Kérés útja (terv 4.4)

Nyers `$request_uri` → alak (`403`) → kiterjesztés-tábla (`404`) → app, `kid`, kulcsfajta, HMAC, `token_path`
(`403`) → lejárat (`410`) → fájl (`404`) → `200`/`206`. A válasz törzse minimális (`forbidden` / `not found` /
`expired`); az ok (`reason`) csak a JSON-naplóban. Érvénytelen tokenre IP-nként ~10 r/s (`429` fölötte);
`limit_conn` felhasználónként 3, appenként 40; `limit_rate_after 30m`, `limit_rate 600k`.

## Kulcsok

- A kulcs **32 véletlen bájt base64url-szövege** (43 jel). A HMAC kulcsa ez a **szöveg UTF-8-ként** (ahogy a
  Bunny is használja); az `apps.json` értékét senki nem dekódolja. Az njs legalább 43 jeles base64(url) szöveget
  fogad el.
- `pnpm media-server:keys <app> [--content] [--kid <id>] [--write <apps.json>] [--dir <könyvtár>]` – kiírja az
  `apps.json`-részletet és a backend-oldali (MS2) értéket; `--write` csak hozzáad (meglévő `kid`-et nem ír felül),
  helyben ír (ugyanaz az inode), új fájlt `0600`-zal hoz létre, a meglévő jogosultságát megtartja.
  Az `apps.json` egy fájlként van csatolva: ha egy szerkesztő új fájlt (új inode-ot) ír helyette, a futó konténer
  a régit látja – ilyenkor `docker compose restart media` kell, nem elég a reload.
- Az `apps.json` tartalmi hibáját az nginx konfigtöltéskor nem látja (csak a JSON-szintaxist): reload előtt
  `docker compose exec -T media njs -q -m -p /etc/nginx/njs /etc/nginx/njs/check-apps.js`. Hibás `apps.json`
  mellett minden kérés `403` (`reason: apps-invalid`).

## Helyi futtatás

```
cp .env.example .env                       # MEDIA_ROOT=./dev-media (csak olvasva), APPS_JSON=./secrets/apps.local.json
pnpm media-server:keys elearning --kid dev1 --dir . --write secrets/apps.local.json
docker compose up -d --wait                # http://127.0.0.1:10090/healthz → 204
pnpm --silent media-server:sign elearning <assetKey> [--u <uuid>]      # --content, --ttl=<mp>, --prefix, --kid, --base
docker compose exec -T media nginx -c /etc/nginx/media/nginx.conf -t           # a konfig a -c-vel érhető el
docker compose exec -T media nginx -c /etc/nginx/media/nginx.conf -s reload
docker compose logs -f media               # JSON-napló, token nélkül
docker compose down
```

A `sign` relatív útvonalai (`--apps`) az `server`-hez képest értendők. Negatív `--ttl` csak `=`-vel
(`--ttl=-10`).

## Docker-integrációs teszt

`pnpm media-server:test` (= `pnpm --filter @workspace/media-server test:docker`; a sima `pnpm test` nem futtatja).
A `test/docker/setup.ts` a `test/.tmp/docker-*/root` alá szintetikus teszt-gyökeret ír (ffmpeg-gel generált 2 s-os
MP4 / M4A / JPG, magolt bináris, ritka 40 MiB-os fájl, szintetikus `_content/<v>.json.gz`; valódi tananyag nem), és
a konténert egyedi projektnévvel (`media-server-test-<pid>-<rand>`), szabad loopback-porttal és szabad
`172.29.<n>.0/24` alhálózattal indítja a `test/fixtures/apps.test.json` kulcsaival; a végén `down -v`, és az
ideiglenes könyvtár törlődik. Docker (futó démon), `docker compose` vagy ffmpeg hiányában a spec üzenettel kihagy.
Megszakított futás után a maradék: `docker compose ls` → `docker compose -p <név> down -v`, `rm -r test/.tmp`.

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
(ebből ír alá a `sign` is), és innen kerülnek fel. Az `apps.json` két példányban él (D12): a fejlesztőgépen
(`secrets/apps.prod.json`, `0600`, gitignore-olt) és a szerveren (`secrets/apps.json`, `0400`); jelszókezelő nincs.
Elvesztése nem adatvesztés: új kulcs + feltöltés + `deploy` + a backend env-je.

Egy app mellé fejlesztői app is felvehető ugyanazzal a `dir`-rel, saját kulcsokkal és a fejlesztői originekkel (D2);
az éles appon nem lazítunk.

```
pnpm media-server:keys <app> --kid <kid> --write secrets/apps.prod.json
pnpm media-server:keys <app> --kid <kid> --content --write secrets/apps.prod.json
pnpm media-server:keys <app>-dev --dir <dir> --kid <kid> --write secrets/apps.prod.json
pnpm media-server:keys <app>-dev --kid <kid> --content --write secrets/apps.prod.json
# az origins és a corp kézzel (a keys:new alapja: origins [], corp same-site; a dir alapból az app neve)
```

A `keys:new` stdout-ja a kulcsot is kiírja: élesben `>/dev/null`-ra irányítandó; a backend env-értéke a helyi
fájlból vehető (`jq -r '.["<app>"].keys' …`).

Feltöltés új fájlként, atomikusan (a régi `0400`-as fájl nem írható felül, és a `mv` új inode-ot ad – a
`deploy.sh` ezt észleli, és `restart`-ot ad):

```
scp server/secrets/apps.prod.json media-host:/srv/media-server/secrets/apps.json.new
ssh media-host 'cd /srv/media-server/secrets && chmod 0400 apps.json.new && mv -f apps.json.new apps.json'
pnpm media-server:deploy                    # check-apps.js, nginx -t, majd restart (új inode)
```

Nincs más mentés (D12): a két példány elég, a kulcs pótolható.

**Rotáció** (appenként és kulcsfajtánként független, terv 4.3): az új `kid` előbb a szerverre (`keys:new --write`
→ feltöltés → `deploy`), csak utána vált rá az aláíró (MS2-ben a backend env-je; a `sign`-nál `--kid`). A régi
kulcs a leghosszabb lejárat után törölhető (böngészős: 6 óra, tartalom: 5 perc): a bejegyzés kézzel ki a helyi
fájlból, újra feltöltés + `deploy`. **Új app:** egy `keys:new` (új app-névvel), `install -d data/<dir>`, feltöltés,
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
2. Kulcsok az `apps.prod.json`-ba: `pnpm media-server:keys masik --kid 2026a --write`, tartalomkulcs kell-e:
   `--content --kid 2026c`; kézzel `dir`, `origins`, `corp` (`same-site`, ha `*.example.com` alatt fut).
3. Az `apps.json` felmásolása (`secrets/apps.json`, 0400) és `pnpm media-server:deploy`.
4. Feltöltő kulcs: `ssh-keygen -t ed25519 -f ~/.ssh/media_upload_masik -N ""`, a fenti sor a saját
   `data/masik` gyökérrel a szerveren a `deploy` `authorized_keys`-ébe (előtte mentés).
5. Az app backendjének env-je: `MEDIA_SERVER_URL`, `MEDIA_SERVER_APP=masik`, `MEDIA_SERVER_KEY_ID`,
   `MEDIA_SERVER_KEYS` (+ `MEDIA_SERVER_CONTENT_KEY_ID`, `MEDIA_SERVER_CONTENT_KEY`).

Kivezetés visszafelé: bejegyzés és kulcssor törlése, deploy, majd a mappa törlése.

### Deploy

```
pnpm media-server:deploy --dry-run          # előfeltételek + az rsync változáslistája; a szerveren nem változik semmi
pnpm media-server:deploy                    # = server/deploy/deploy.sh
```

Környezet: `DEPLOY_HOST` (alap `media-host`), `DEPLOY_USER` (`deploy`), `DEPLOY_DIR` (`/srv/media-server`),
`DEPLOY_SSH_OPTS` (`-o BatchMode=yes -o ConnectTimeout=10`). Ha az mDNS kihagy (P16), az IP-vel, a meglévő
host-kulcsra hivatkozva (a `known_hosts` `media-host`-bejegyzése):

```
DEPLOY_HOST=192.0.2.10 DEPLOY_SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -o HostKeyAlias=media-host" pnpm media-server:deploy
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

Útvonalak (`data/` alatt): `elearning/proba-tema/lessons/ch-01-l01/m01.720p.mp4` (`.audio.m4a`, `.poster.jpg`,
`.720p.mp4.build.json`), `elearning/_content/2026.11.23-proba.json.gz`, `proba/proba-tema/lessons/ch-01-l01/m01.720p.mp4`.
A 44 perces fájl teljes letöltése a `limit_rate_after 30m` / `limit_rate 600k` miatt ~13 perc (szándékos).

### Próbalink

```
pnpm --silent media-server:sign <app> <assetKey> --apps secrets/apps.prod.json --base https://media.example.com [--u <uuid>] [--kid <kid>]
pnpm --silent media-server:sign <app> _content/<v>.json.gz --content --apps secrets/apps.prod.json --base https://media.example.com
curl -sI '<url>'                            # 200; Range: curl -s -o /dev/null -w '%{http_code}\n' -r 0-99 '<url>' → 206
```

Az app `dir`-je a szerveren `<dir>`, tehát a `<assetKey>` a `data/<dir>/` alatti
relatív útvonal. A `sign` a `_content/`-et csak `--content`-tel (tartalomkulccsal) írja alá; a szerver a böngészős
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
