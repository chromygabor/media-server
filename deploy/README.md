# deploy/media-host – a médiaszerver telepítése a szerverre (üzemeltetői kézikönyv)

A termék (a `../../server/`: image, konfig, njs, tesztek) egy konkrét telepítése. Terv 7.3, implementációs terv WP4,
kiemelési terv WP49. A media-host (`media-host`, felhasználó `deploy`, a `docker` csoport tagja) host-nginxe (1.24) a
TLS-végpont a wildcard tanúsítvánnyal (`*.example.com`); a médiaszerver konténere csak a loopbacken
(`127.0.0.1:10090`) érhető el, a `media.example.com` blokk proxyz rá. A 80-as `00-http` site már HTTPS-re irányít,
oda nem kell semmi.

```
compose.yaml              a szerver compose-a: image media-server:${IMAGE_TAG} (pull_policy: never), az apps.json és a
                          MEDIA_ROOT csak olvasva, read_only, tmpfs, 127.0.0.1:10090, rögzített alhálózat, health, napló
.env.example              a szerver .env-jének mintája (MEDIA_ROOT, APPS_JSON, IMAGE_TAG, PREVIOUS_IMAGE_TAG, BIND, PORT, NET_*)
host-nginx.conf.example   a host-nginx media.example.com blokkja (TLS, proxy a 10090-re, nyers URI)
deploy.sh                 telepítés (pnpm server:deploy …): image, docker-teszt, átvitel, ellenőrzés, váltás
secrets/                  gitignore-olt: apps.json = a szerver apps.json-jának helyi példánya (D12)
```

Regisztry nincs: az image a fejlesztőgépen épül és tesztelődik, és `docker save | gzip | ssh … docker load`-dal kerül
a szerverre. A szerveren nincs Node és nincs build.

## Könyvtárfa a szerveren

```
/srv/media-server/                (deploy:docker, 0755; egyszeri sudo-lépés)
  compose.yaml                    a repóból (deploy.sh); az előző példány compose.yaml.prev
  .env                            kézzel (lásd lent); a deploy.sh CSAK az IMAGE_TAG és a PREVIOUS_IMAGE_TAG sort írja
  secrets/                        0700
    apps.json                     csak itt, 0400; a deploy.sh soha nem írja
  data/                           MEDIA_ROOT; a deploy.sh soha nem írja
    elearning/                    az appok közös gyökere
    proba/                        a volt próba app gyökere (D13: az app törölve; a könyvtár a WP23-ban törlendő)
  nginx/, njs/                    CSAK a WP49 előtti elrendezésből (csatolt konfig); lásd Átállás
```

Az image-ek a szerver docker-tárában: `media-server:<verzió>-<rövid SHA>` (a futó az `IMAGE_TAG`, a visszaállás célja
a `PREVIOUS_IMAGE_TAG`).

## Első telepítés

### Egyszeri sudo-lépések (a tulajdonos)

A host-blokk példánya a szerveren: `~/media-server-host.conf` (= `host-nginx.conf.example`). Sorrend: előbb a
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

Az `IMAGE_TAG` és a `PREVIOUS_IMAGE_TAG` sort az első deploy teszi a végére. A `172.29.90.0/24` és a `10090` az alapérték. Ha ütközne, a
`.env`-ben a `NET_SUBNET` / `NET_GATEWAY` együtt váltandó (a `real_ip` az átjárót bízza meg).

### Az `apps.json` és az első deploy

Kulcsok és feltöltés: lent, „Kulcsok”. Utána a repó gyökeréből:

```
pnpm install && pnpm build             # a docker-teszt a media-sdk dist/-jéből fut
pnpm server:deploy --dry-run           # helyben épít és tesztel; a szerveren csak olvas
pnpm server:deploy
```

### Átállás a WP49 előtti elrendezésről (a media-host mai állapota)

A WP49 előtt a szerveren a hivatalos `nginx` image futott, a repóból rsync-elt `nginx/` és `njs/` csatolásával. Az
első új deploy: a `.env`-ben még nincs `IMAGE_TAG` (a dry-run ezt jelzi), az rsync a régi `compose.yaml`-t
`compose.yaml.prev` néven megtartja, a váltás után az új konténer a saját image-ből fut. A `nginx/` és az `njs/`
könyvtárat a deploy nem törli. Ennek az egy váltásnak nincs `--rollback`-je (előző címke nincs); kézi visszaállás a
régi elrendezésre (a helyi főpróbán kipróbálva):

```
ssh media-host 'cd /srv/media-server && cp compose.yaml.prev compose.yaml && docker compose up -d --wait'
```

Ha az új elrendezés egy deploy-ciklusig rendben fut: `ssh media-host 'cd /srv/media-server && rm -r nginx njs
compose.yaml.prev'` (előtte `find nginx njs -type l` üres).

## Deploy

```
pnpm server:deploy --dry-run           # építés + docker-teszt helyben, a szerver ellenőrzése, terv; a szerveren nem változik semmi
pnpm server:deploy                     # = deploy/deploy.sh
pnpm server:deploy --keep 3            # ugyanez, utána a régi image-ek takarítása (a mostani, az előző és a legújabb 3 marad)
pnpm server:deploy --allow-dirty       # piszkos munkafáról (csak kivételesen; címke: …-dirty-<időbélyeg>)
pnpm server:deploy --help
```

Lépések:

1. **Image helyben:** `server/scripts/image-build.sh` → `media-server:<a server/package.json verziója>-<rövid SHA>`,
   OCI-címkékkel (`revision`, `version`, `source`). Piszkos munkafánál megtagad (`--allow-dirty` nélkül).
2. **Docker-teszt ezen az image-en** (`MEDIA_IMAGE=<címke> MEDIA_DOCKER_REQUIRED=1 pnpm test:docker`; docker és
   ffmpeg kell). Csak tesztelt image megy ki.
3. **A szerver ellenőrzése** (csak olvasás): a `DEPLOY_DIR` létezik és írható, a `.env` és a `secrets/apps.json`
   megvan, a `.env` `APPS_JSON` / `MEDIA_ROOT` útvonala létezik (különben a docker root-ként hozná létre),
   `docker compose` és `curl` elérhető; a futó image, az `IMAGE_TAG` és a `PREVIOUS_IMAGE_TAG`. Hiánynál egyértelmű
   `HIBA:` sor, nem nulla kilépés, a szerveren semmi nem változik.
4. **Átvitel:** `docker save | gzip -1 | ssh … 'gunzip | docker load'` (~28 MB). Kimarad, ha a címke ugyanazzal a
   tartalommal (a `revision` címke és a rétegek ujjlenyomata) már a szerveren van; utána az ujjlenyomat ellenőrizve.
5. **rsync** csak a `compose.yaml`-ra (`--checksum`: csak tartalmi változásnál íródik; a régi `compose.yaml.prev`).
   A `.env`, a `secrets/` és a `data/` sosem íródik és nem törlődik (kivétel: a 7. lépés két sora).
6. **Ellenőrzés az új image-dzsel**, a mostani `apps.json`-nal, eldobható konténerben (`docker compose run --rm`):
   `docker compose config -q`, `check-apps.js`, `nginx -c /etc/nginx/media/nginx.conf -t`. Hibánál megáll; a futó
   konténer és a `.env` változatlan.
7. **Váltás:** a `.env` `IMAGE_TAG`-je az új, a `PREVIOUS_IMAGE_TAG` a régi címke (ideiglenes fájl a
   `DEPLOY_DIR`-ben, a jogosultság megtartva, `mv`; a többi sor változatlan); `docker compose up -d --wait`;
   `/healthz` → `204`. Ha az indulás vagy a `/healthz` nem sikerül: a `.env` vissza a régi címkére, és a régi image
   újraindul (a deploy hibával áll meg). Ugyanannak a címkének az újbóli deployja nem írja a `.env`-et; ha a konténer
   marad, a `compose.yaml` vagy az `apps.json` új inode-jánál restart, különben `nginx -s reload`.
8. **Takarítás** csak `--keep N`-nel (N ≥ 2): a `media-server:<verzió>-<SHA>` image-ek közül a mostani, az előző és
   a legújabb N marad. Alapból nincs: a szkript csak a saját `.env`-jét látja, egy közös docker-hoszton egy másik
   telepítés előző image-ét is törölhetné (a főpróbán így történt).

Környezet: `DEPLOY_HOST` (alap `media-host`), `DEPLOY_USER` (`deploy`), `DEPLOY_DIR` (`/srv/media-server`),
`DEPLOY_SSH_OPTS` (`-o BatchMode=yes -o ConnectTimeout=10`). Ha az mDNS kihagy (P16), az IP-vel, a meglévő
host-kulcsra hivatkozva (a `known_hosts` `media-host`-bejegyzése):

```
DEPLOY_HOST=192.0.2.10 DEPLOY_SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -o HostKeyAlias=media-host" pnpm server:deploy
```

Ugyanez a kézi `ssh` / `scp`-nél: `-o HostKeyAlias=media-host deploy@media-host`.

## Visszaállás

```
pnpm server:deploy --rollback --dry-run
pnpm server:deploy --rollback
```

Az előző image-dzsel (`PREVIOUS_IMAGE_TAG`) `check-apps.js` + `nginx -t` eldobható konténerben, majd a két címke
helyet cserél a `.env`-ben, `up -d --wait`, `/healthz`; hibánál marad a mostani. Egy újabb `--rollback` visszavált.
A `compose.yaml` nem változik (ha a két változat között a `compose.yaml` is változott, a régi a `compose.yaml.prev`).
Régebbi image-re: `IMAGE_TAG` kézzel nem írandó; a régi commit egy munkapéldányából `pnpm server:deploy` (újraépít,
tesztel, és ha a szerveren lévő azonos címkéjű image tartalma eltér, újra átviszi).

Az `apps.json` új mezőit (`publicKeys`/`contentPublicKeys`) a WP52 előtti njs figyelmen kívül hagyja (a `validateApps`
a nem ismert mezőt nem tiltja). Kipróbálva 2026-11-24: a régi `nginx/` + `njs/` a vegyes `test/fixtures/apps.test.json`-nal
`nginx -t` és `check-apps.js` rendben, a HMAC-link `200`, az ES256-link `403 malformed-token`.

## Kulcsok és az `apps.json`

A kulcsok a fejlesztőgépen készülnek (a szerveren nincs Node), a gitignore-olt `deploy/secrets/apps.json`-ba
(ebből ír alá a `pnpm sign` is), és innen kerülnek fel. Az `apps.json` két példányban él (D12): a fejlesztőgépen
(`deploy/secrets/apps.json`, `0600`) és a szerveren (`secrets/apps.json`, `0400`); jelszókezelő nincs.
Elvesztése nem adatvesztés: új kulcs + feltöltés + `--reload-config` + a backend env-je. A helyi könyvtár egyszer:
`install -d -m 0700 deploy/secrets`.

A `pnpm keys` / `pnpm sign` relatív útvonalai a `server/`-hez képest értendők, ezért `../deploy/…`.

Egy app mellé fejlesztői app is felvehető ugyanazzal a `dir`-rel, saját kulcsokkal és a fejlesztői originekkel (D2);
az éles appon nem lazítunk.

```
pnpm keys <app> --kid <kid> --write ../deploy/secrets/apps.json
pnpm keys <app> --kid <kid> --content --write ../deploy/secrets/apps.json
pnpm keys <app>-dev --dir <dir> --kid <kid> --write ../deploy/secrets/apps.json
pnpm keys <app>-dev --kid <kid> --content --write ../deploy/secrets/apps.json
# az origins és a corp kézzel (a pnpm keys alapja: origins [], corp same-site; a dir alapból az app neve)
```

A `pnpm keys` stdout-ja a kulcsot is kiírja: élesben `>/dev/null`-ra irányítandó. ES256-`kid` (az app saját
kulcspárja, csak a nyilvános kulcs jön): `pnpm keys --register <app> --kid <kid> --public-key <kulcs> [--content]
--write ../deploy/secrets/apps.json`; a nyilvános kulcs első és utolsó 8 jelét egy második csatornán
egyeztetni kell.

**Feltöltés és élesítés** új fájlként, atomikusan (a régi `0400`-as fájl nem írható felül, és a `mv` új inode-ot ad –
a `--reload-config` ezt észleli, és restartol):

```
scp deploy/secrets/apps.json media-host:/srv/media-server/secrets/apps.json.new
ssh media-host 'cd /srv/media-server/secrets && chmod 0400 apps.json.new && mv -f apps.json.new apps.json'
pnpm server:deploy --reload-config    # check-apps.js + nginx -t a futó image-dzsel, majd restart (új inode), /healthz
```

A `--reload-config` image-et nem épít és nem cserél, a `compose.yaml`-t nem szinkronizálja. Ha a `check-apps.js`
vagy az `nginx -t` elbukik, a futó konténer a régi `apps.json`-nal fut tovább (az új fájl már a helyén van: a régit
vissza kell tölteni, vagy a hibát javítani, és újra `--reload-config`).

**Rotáció** (appenként és kulcsfajtánként független, terv 4.3): az új `kid` előbb a szerverre (`pnpm keys … --write`
→ feltöltés → `--reload-config`), csak utána vált rá az aláíró (a backend env-je; a `pnpm sign`-nál `--kid`). A régi
kulcs a leghosszabb lejárat után törölhető (böngészős: 6 óra, tartalom: 5 perc): a bejegyzés kézzel ki a helyi
fájlból, újra feltöltés + `--reload-config`.

## Feltöltő kulcs és új app

Feltöltés (a fogyasztó feltöltő eszközével) nem külön felhasználóval megy, hanem a `deploy`-ra appenként
egy **korlátozott kulccsal**: a `~/.ssh/authorized_keys` egy sora csak `rrsync`-et enged, csak az app könyvtárába.
A `restrict` kulcsonként tiltja a shellt, a terminált és a továbbításokat; a `deploy` többi kulcsa változatlan.

```
restrict,command="/usr/bin/rrsync -munge /srv/media-server/data/<dir>" ssh-ed25519 AAAA… media-upload-<app>
```

Új app (pl. `masik`) felvétele – sudo, nginx- és kódváltozás nélkül:

1. `mkdir /srv/media-server/data/masik` (a szerveren, `deploy`-ként).
2. Kulcsok a helyi `apps.json`-ba: `pnpm keys masik --kid 2026a --write ../deploy/secrets/apps.json`,
   tartalomkulcs kell-e: `--content --kid 2026c`; kézzel `dir`, `origins`, `corp` (`same-site`, ha `*.example.com`
   alatt fut).
3. Feltöltés (fent) és `pnpm server:deploy --reload-config`.
4. Feltöltő kulcs: `ssh-keygen -t ed25519 -f ~/.ssh/media_upload_masik -N ""`, a fenti sor a saját
   `data/masik` gyökérrel a szerveren a `deploy` `authorized_keys`-ébe (előtte mentés).
5. Az app backendjének env-je: `MEDIA_SERVER_URL`, `MEDIA_SERVER_APP=masik`, `MEDIA_SERVER_KEY_ID`,
   `MEDIA_SERVER_KEYS` (+ `MEDIA_SERVER_CONTENT_KEY_ID`, `MEDIA_SERVER_CONTENT_KEY`).

Kivezetés visszafelé: bejegyzés és kulcssor törlése, `--reload-config`, majd a mappa törlése.

## Próbafájlok (csak szintetikus)

A szerverre csak szintetikus média kerül próbának (valódi tartalom nem része a repónak). A
`server/scripts/make-test-video.sh` ffmpeg-gel generál (a szerveren nincs ffmpeg, ezért helyben, és `rsync`-kel fel):

```
server/scripts/make-test-video.sh /tmp/media-data          # 44 perces 720p MP4 (~495 MB, +faststart), M4A, JPG,
                                                           # .build.json, _content/2026.11.23-proba.json.gz, proba/…
rsync -rt --chmod=D755,F644 /tmp/media-data/ media-host:/srv/media-server/data/
```

Útvonalak (`data/` alatt; a szkript 2026-11-24 óta a `demo/` alá ír, az élő elfogadás 2026-11-23-án még az
`elearning/` alá generált, az alábbi a szerveren lévő állapot): `elearning/proba-tema/lessons/ch-01-l01/m01.720p.mp4`
(`.audio.m4a`, `.poster.jpg`, `.720p.mp4.build.json`), `elearning/_content/2026.11.23-proba.json.gz`,
`proba/proba-tema/lessons/ch-01-l01/m01.720p.mp4`. A 44 perces fájl teljes letöltése a `limit_rate_after 30m` /
`limit_rate 600k` miatt ~13 perc (szándékos).

## Próbalink

```
pnpm --silent sign <app> <assetKey> --apps ../deploy/secrets/apps.json --base https://media.example.com [--u <uuid>] [--kid <kid>]
pnpm --silent sign <app> _content/<v>.json.gz --content --apps ../deploy/secrets/apps.json --base https://media.example.com
curl -sI '<url>'                            # 200; Range: curl -s -o /dev/null -w '%{http_code}\n' -r 0-99 '<url>' → 206
```

Az app `dir`-je a szerveren `<dir>`, tehát a `<assetKey>` a `data/<dir>/` alatti
relatív útvonal. A `pnpm sign` a `_content/`-et csak `--content`-tel (tartalomkulccsal) írja alá; a szerver a böngészős
kulccsal aláírt `_content/`-kérést `403`-mal utasítja el. ES256-`kid`-hez az üzemeltető nem tud aláírni: azt az app adja
(`media-sign --env-file`).

## Hibakeresés

```
ssh media-host
cd /srv/media-server
docker compose ps                                   # állapot, health, a futó image címkéje
docker compose logs --tail 100 -f media             # JSON-napló (app, kid, u, path, status, reason, IP; token nélkül)
docker compose exec -T media nginx -c /etc/nginx/media/nginx.conf -t   # a konfig CSAK a -c-vel érhető el
docker compose exec -T media nginx -c /etc/nginx/media/nginx.conf -T   # a betöltött teljes konfig
docker compose exec -T media njs -q -m -p /etc/nginx/njs /etc/nginx/njs/check-apps.js
docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' media-server:$(sed -n 's/^IMAGE_TAG=//p' .env)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:10090/healthz     # 204
```

- A `nginx -t` / `-s reload` `-c` nélkül az image alapkonfigját nézi, nem a miénket.
- Minden kérés `403`, `reason: apps-invalid` → hibás `apps.json` (a `check-apps.js` megmondja, mi).
- `media.example.com` → `502`: a konténer nem fut, vagy nem a `10090`-on. A host blokkja szándékosan nem
  naplóz (`access_log off`, `error_log … crit`, mert a hibasorban a tokenes kérés-sor is benne volna); a diagnózis a
  konténer naplója és a `/healthz`.
- Az `apps.json` cseréje után a futó konténer a régi fájlt látja (egy fájlként csatolt kötet): `pnpm server:deploy
  --reload-config` (restartol, ha új az inode).
- A `.env` `IMAGE_TAG`-je nélkül a `docker compose` hibát ad (`IMAGE_TAG kell`): előbb egy deploy kell.

## Főpróba helyben (media-host nélkül)

`DEPLOY_TRANSPORT=local`: ssh és rsync-cél nélkül a „szerver” a helyi gép és egy scratch `DEPLOY_DIR` (ugyanaz a
távoli szkript fut, `bash -s`-sel); a helyi docker-démon a „szerveré” is, ezért az átvitel kimarad (a címke már
megvan). Egy szabad port, alhálózat és projektnév kell a scratch `.env`-ben:

```
D=/tmp/media-proba; install -d $D/data/demo && install -d -m 0700 $D/secrets
(cd server && pnpm -w keys demo --kid p1 --write $D/secrets/apps.json >/dev/null) && chmod 0400 $D/secrets/apps.json
printf '%s\n' MEDIA_ROOT=$D/data APPS_JSON=./secrets/apps.json BIND=127.0.0.1 PORT=10190 \
  NET_SUBNET=172.29.191.0/24 NET_GATEWAY=172.29.191.1 COMPOSE_PROJECT_NAME=media-server-proba > $D/.env
DEPLOY_TRANSPORT=local DEPLOY_DIR=$D deploy/deploy.sh [--dry-run | --rollback | --reload-config]
(cd $D && IMAGE_TAG=x docker compose down -v)
```
