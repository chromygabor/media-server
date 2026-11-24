# deploy/ – a médiaszerver telepítése (üzemeltetői kézikönyv)

A termék (a `../server/`: image, konfig, njs, tesztek) telepítése egy célgépre, regisztry nélkül: az image a
fejlesztőgépen épül és tesztelődik, és `docker save | gzip | ssh … docker load`-dal kerül a célgépre. A célgépen nincs
Node és nincs build; docker + `docker compose`, curl, és egy TLS-végpont (pl. a host nginxe) kell.

```
deploy.sh                 telepítés (pnpm server:deploy <cél> …): image, docker-teszt, átvitel, ellenőrzés, váltás
compose.yaml              a célgép compose-a: image media-server:${IMAGE_TAG} (pull_policy: never), az apps.json és a
                          MEDIA_ROOT csak olvasva, read_only, tmpfs, 127.0.0.1:<PORT>, rögzített alhálózat, health, napló
.env.example              a célgépi .env mintája (MEDIA_ROOT, APPS_JSON, IMAGE_TAG, PREVIOUS_IMAGE_TAG, BIND, PORT, NET_*)
target.env.example        a fejlesztőgépi cél-könyvtár .env-jének mintája (DEPLOY_HOST, DEPLOY_USER, DEPLOY_DIR, …)
host-nginx.conf.example   minta a host-nginx blokkjához (TLS, proxy a loopback-portra, nyers URI)
<cél>/                    gitignore-olt (deploy/*/): egy telepítés saját adatai, lásd „Új cél”
```

A `deploy/` közvetlen fájljai generikusak és követettek. Minden, ami egy konkrét telepítésre jellemző (hoszt,
felhasználó, könyvtár, az `apps.json` helyi példánya), a `deploy/<cél>/` alatt él, és **soha nem kerül a repóba**
(a `deploy.sh` meg is áll, ha a cél könyvtárában követett fájlt talál).

## Új cél

A fejlesztőgépen, a repó gyökeréből (a `<cél>` egy rövid név, pl. `prod`):

```
install -d -m 0700 deploy/<cél> deploy/<cél>/secrets
cp deploy/target.env.example deploy/<cél>/.env       # DEPLOY_HOST, DEPLOY_USER, DEPLOY_DIR kitöltése
pnpm server:deploy <cél> --dry-run
```

A `deploy/<cél>/.env` csak `DEPLOY_*` kulcsokat tartalmazhat (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_DIR`,
`DEPLOY_SSH_OPTS`, `DEPLOY_TRANSPORT`); a környezetben megadott érték felülírja (pl. egyszeri `DEPLOY_HOST=<IP>`).
A cél útvonallal is megadható (`deploy/deploy.sh /valahol/cel …`), vagy a `DEPLOY_TARGET` változóval. A
`deploy/<cél>/secrets/apps.json` a célgép `apps.json`-jának helyi példánya (innen kerül fel, és ebből ír alá a
`pnpm sign`); a `deploy.sh` nem olvassa.

## Könyvtárfa a célgépen

```
/srv/media-server/                (DEPLOY_DIR; a deploy-felhasználóé, docker csoport, 0755; egyszeri sudo-lépés)
  compose.yaml                    a repóból (deploy.sh); az előző példány compose.yaml.prev
  .env                            kézzel (lásd lent); a deploy.sh CSAK az IMAGE_TAG és a PREVIOUS_IMAGE_TAG sort írja
  secrets/                        0700
    apps.json                     csak itt, 0400; a deploy.sh soha nem írja
  data/                           MEDIA_ROOT; a deploy.sh soha nem írja
    <app-könyvtár>/               az apps.json `dir`-jei
```

Az image-ek a célgép docker-tárában: `media-server:<verzió>-<rövid SHA>` (a futó az `IMAGE_TAG`, a visszaállás célja
a `PREVIOUS_IMAGE_TAG`).

## Első telepítés

### Egyszeri sudo-lépések a célgépen

A példákban a célgép `media-host`, a deploy-felhasználó `deploy`, a könyvtár `/srv/media-server`, a nyilvános név
`media.example.com`: ezek a saját értékre cserélendők. Sorrend: előbb a könyvtár, utána (a konténer első indítása után,
hogy ne legyen `502`) a host-blokk.

```
sudo install -d -o deploy -g docker -m 0755 /srv/media-server
# a host-nginx.conf.example saját értékekkel, a célgépen pl. ~/media-server-host.conf néven:
sudo install -o root -g root -m 0644 ~/media-server-host.conf /etc/nginx/sites-available/media-server
sudo ln -s /etc/nginx/sites-available/media-server /etc/nginx/sites-enabled/media-server
sudo nginx -t && sudo systemctl reload nginx
```

Visszaállás: `sudo rm /etc/nginx/sites-enabled/media-server && sudo nginx -t && sudo systemctl reload nginx`.

### `.env` és könyvtárak a célgépen (sudo nélkül)

```
ssh deploy@media-host 'install -d -m 0700 /srv/media-server/secrets && install -d /srv/media-server/data/demo'
ssh deploy@media-host 'cat > /srv/media-server/.env' <<'EOF'
MEDIA_ROOT=/srv/media-server/data
APPS_JSON=./secrets/apps.json
BIND=127.0.0.1
PORT=10090
NET_SUBNET=172.29.90.0/24
NET_GATEWAY=172.29.90.1
COMPOSE_PROJECT_NAME=media-server
EOF
```

Az `IMAGE_TAG` és a `PREVIOUS_IMAGE_TAG` sort az első deploy teszi a végére. A port és az alhálózat legyen szabad a
célgépen (`docker network ls`, `ss -ltn`); ütközésnél a `NET_SUBNET` / `NET_GATEWAY` együtt váltandó (a `real_ip` az
átjárót bízza meg), a `PORT` a host-blokk `proxy_pass`-ával együtt.

### Az `apps.json` és az első deploy

Kulcsok: lent, „Kulcsok”. Utána a repó gyökeréből:

```
pnpm install && pnpm build             # a docker-teszt a media-sdk dist/-jéből fut
pnpm server:deploy <cél> --dry-run     # helyben épít és tesztel; a célgépen csak olvas
pnpm server:deploy <cél>
```

Ha a célgépen korábban egy régebbi elrendezés futott (más `compose.yaml`, `IMAGE_TAG` nélkül): az rsync a régi
`compose.yaml`-t `compose.yaml.prev` néven megtartja. Ennek az első váltásnak nincs `--rollback`-je (előző címke
nincs); kézi visszaállás: `cd /srv/media-server && cp compose.yaml.prev compose.yaml && docker compose up -d --wait`.

## Deploy (frissítés)

```
pnpm server:deploy <cél> --dry-run     # építés + docker-teszt helyben, a célgép ellenőrzése, terv; a célgépen nem változik semmi
pnpm server:deploy <cél>               # = deploy/deploy.sh <cél>
pnpm server:deploy <cél> --keep 3      # ugyanez, utána a régi image-ek takarítása (a mostani, az előző és a legújabb 3 marad)
pnpm server:deploy <cél> --allow-dirty # piszkos munkafáról (csak kivételesen; címke: …-dirty-<időbélyeg>)
pnpm server:deploy --help
```

Lépések:

1. **Image helyben:** `server/scripts/image-build.sh` → `media-server:<a server/package.json verziója>-<rövid SHA>`,
   OCI-címkékkel (`revision`, `version`, `source`). Piszkos munkafánál megtagad (`--allow-dirty` nélkül).
2. **Docker-teszt ezen az image-en** (`MEDIA_IMAGE=<címke> MEDIA_DOCKER_REQUIRED=1 pnpm test:docker`; docker és
   ffmpeg kell). Csak tesztelt image megy ki.
3. **A célgép ellenőrzése** (csak olvasás): a `DEPLOY_DIR` létezik és írható, a `.env` és a `secrets/apps.json`
   megvan, a `.env` `APPS_JSON` / `MEDIA_ROOT` útvonala létezik (különben a docker root-ként hozná létre),
   `docker compose` és `curl` elérhető; a futó image, az `IMAGE_TAG` és a `PREVIOUS_IMAGE_TAG`. Hiánynál egyértelmű
   `HIBA:` sor, nem nulla kilépés, a célgépen semmi nem változik.
4. **Átvitel:** `docker save | gzip -1 | ssh … 'gunzip | docker load'` (~28 MB). Kimarad, ha a címke ugyanazzal a
   tartalommal (a `revision` címke és a rétegek ujjlenyomata) már a célgépen van; utána az ujjlenyomat ellenőrizve.
5. **rsync** csak a `deploy/compose.yaml`-ra (`--checksum`: csak tartalmi változásnál íródik; a régi `compose.yaml.prev`).
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
   telepítés előző image-ét is törölhetné.

Ha a célgép neve nem oldódik fel, az IP-vel, a meglévő host-kulcsra hivatkozva (egyszeri felülírás a környezetből):

```
DEPLOY_HOST=192.0.2.10 DEPLOY_SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -o HostKeyAlias=media-host" pnpm server:deploy <cél>
```

## Visszaállás (rollback)

```
pnpm server:deploy <cél> --rollback --dry-run
pnpm server:deploy <cél> --rollback
```

Az előző image-dzsel (`PREVIOUS_IMAGE_TAG`) `check-apps.js` + `nginx -t` eldobható konténerben, majd a két címke
helyet cserél a `.env`-ben, `up -d --wait`, `/healthz`; hibánál marad a mostani. Egy újabb `--rollback` visszavált.
A `compose.yaml` nem változik (ha a két változat között a `compose.yaml` is változott, a régi a `compose.yaml.prev`).
Régebbi image-re: `IMAGE_TAG` kézzel nem írandó; a régi commit egy munkapéldányából `pnpm server:deploy <cél>`
(újraépít, tesztel, és ha a célgépen lévő azonos címkéjű image tartalma eltér, újra átviszi).

## Kulcsok, `apps.json`, `--reload-config` (kulcsforgatás)

A kulcsok a fejlesztőgépen készülnek (a célgépen nincs Node), a gitignore-olt `deploy/<cél>/secrets/apps.json`-ba,
és innen kerülnek fel. Az `apps.json` két példányban él: a fejlesztőgépen (`0600`) és a célgépen (`secrets/apps.json`,
`0400`). Elvesztése nem adatvesztés: új kulcs + feltöltés + `--reload-config` + az appok env-je.

A `pnpm keys` / `pnpm sign` relatív útvonalai a `server/`-hez képest értendők, ezért `../deploy/<cél>/…`:

```
pnpm keys demo --kid 2026a --write ../deploy/<cél>/secrets/apps.json >/dev/null
pnpm keys demo --kid 2026c --content --write ../deploy/<cél>/secrets/apps.json >/dev/null
# az origins és a corp kézzel (a pnpm keys alapja: origins [], corp same-site; a dir alapból az app neve)
```

A `pnpm keys` stdout-ja a kulcsot is kiírja: élesben `>/dev/null`-ra irányítandó. ES256-`kid` (az app saját
kulcspárja, csak a nyilvános kulcs jön): `pnpm keys --register <app> --kid <kid> --public-key <kulcs> [--content]
--write ../deploy/<cél>/secrets/apps.json`; a nyilvános kulcs első és utolsó 8 jelét egy második csatornán
egyeztetni kell (SPEC, App-regisztráció).

**Feltöltés és élesítés** új fájlként, atomikusan (a régi `0400`-as fájl nem írható felül, és a `mv` új inode-ot ad –
a `--reload-config` ezt észleli, és restartol):

```
scp deploy/<cél>/secrets/apps.json deploy@media-host:/srv/media-server/secrets/apps.json.new
ssh deploy@media-host 'cd /srv/media-server/secrets && chmod 0400 apps.json.new && mv -f apps.json.new apps.json'
pnpm server:deploy <cél> --reload-config   # check-apps.js + nginx -t a futó image-dzsel, majd restart (új inode), /healthz
```

A `--reload-config` image-et nem épít és nem cserél, a `compose.yaml`-t nem szinkronizálja. Ha a `check-apps.js`
vagy az `nginx -t` elbukik, a futó konténer a régi `apps.json`-nal fut tovább (az új fájl már a helyén van: a régit
vissza kell tölteni, vagy a hibát javítani, és újra `--reload-config`).

**Forgatás** (appenként és kulcsfajtánként független; SPEC 7.): az új `kid` előbb a célgépre (`pnpm keys … --write`
→ feltöltés → `--reload-config`), csak utána vált rá az aláíró (az app env-je). A régi kulcs a leghosszabb lejárat
után törölhető: a bejegyzés kézzel ki a helyi fájlból, újra feltöltés + `--reload-config`.

## Feltöltő kulcs és új app

Feltöltés (rsync, SPEC 8.) appenként egy **korlátozott kulccsal**: a deploy-felhasználó `~/.ssh/authorized_keys`-ének
egy sora csak `rrsync`-et enged, csak az app könyvtárába. A `restrict` kulcsonként tiltja a shellt, a terminált és a
továbbításokat.

```
restrict,command="/usr/bin/rrsync -munge /srv/media-server/data/<dir>" ssh-ed25519 AAAA… media-upload-<app>
```

Új app (pl. `masik`) felvétele – sudo, nginx- és kódváltozás nélkül:

1. `mkdir /srv/media-server/data/masik` (a célgépen, a deploy-felhasználóként).
2. Kulcsok a helyi `apps.json`-ba: `pnpm keys masik --kid 2026a --write ../deploy/<cél>/secrets/apps.json`,
   tartalomkulcs kell-e: `--content --kid 2026c`; kézzel `dir`, `origins`, `corp`.
3. Feltöltés (fent) és `pnpm server:deploy <cél> --reload-config`.
4. Feltöltő kulcs: az app nyilvános ed25519-kulcsa a fenti sorral, a saját `data/masik` gyökérrel a deploy-felhasználó
   `authorized_keys`-ébe (előtte mentés).
5. Az app env-je (SPEC 9.): `MEDIA_SERVER_URL`, `MEDIA_SERVER_APP=masik`, `MEDIA_SERVER_KEY_ID`, `MEDIA_SERVER_KEYS`
   (+ `MEDIA_SERVER_CONTENT_KEY_ID`, `MEDIA_SERVER_CONTENT_KEY`).

Kivezetés visszafelé: bejegyzés és kulcssor törlése, `--reload-config`, majd a mappa törlése.

## Próbafájlok és próbalink

A célgépre próbának csak szintetikus média kerüljön. A `server/scripts/make-test-video.sh` ffmpeg-gel generál
(helyben, majd `rsync`-kel fel):

```
server/scripts/make-test-video.sh /tmp/media-data          # 44 perces 720p MP4 (+faststart), M4A, JPG, _content/…
rsync -rt --chmod=D755,F644 /tmp/media-data/ deploy@media-host:/srv/media-server/data/

pnpm --silent sign demo <assetKey> --apps ../deploy/<cél>/secrets/apps.json --base https://media.example.com
curl -sI '<url>'                            # 200; Range: curl -s -o /dev/null -w '%{http_code}\n' -r 0-99 '<url>' → 206
```

A `pnpm sign` a `_content/`-et csak `--content`-tel (tartalomkulccsal) írja alá. ES256-`kid`-hez az üzemeltető nem
tud aláírni: azt az app adja (`media-sign --env-file`).

## Hibakeresés

```
ssh deploy@media-host
cd /srv/media-server
docker compose ps                                   # állapot, health, a futó image címkéje
docker compose logs --tail 100 -f media             # JSON-napló (app, kid, u, path, status, reason, IP; token nélkül)
docker compose exec -T media nginx -c /etc/nginx/media/nginx.conf -t   # a konfig CSAK a -c-vel érhető el
docker compose exec -T media njs -q -m -p /etc/nginx/njs /etc/nginx/njs/check-apps.js
docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' media-server:$(sed -n 's/^IMAGE_TAG=//p' .env)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:10090/healthz     # 204
```

- A `nginx -t` / `-s reload` `-c` nélkül az image alapkonfigját nézi, nem a miénket.
- Minden kérés `403`, `reason: apps-invalid` → hibás `apps.json` (a `check-apps.js` megmondja, mi).
- A nyilvános név `502`-t ad: a konténer nem fut, vagy nem a `.env` portján. A host blokkja szándékosan nem naplóz
  (`access_log off`, `error_log … crit`, mert a hibasorban a tokenes kérés-sor is benne volna); a diagnózis a
  konténer naplója és a `/healthz`.
- Az `apps.json` cseréje után a futó konténer a régi fájlt látja (egy fájlként csatolt kötet):
  `pnpm server:deploy <cél> --reload-config` (restartol, ha új az inode).
- A `.env` `IMAGE_TAG`-je nélkül a `docker compose` hibát ad (`IMAGE_TAG kell`): előbb egy deploy kell.

## Főpróba helyben (célgép nélkül)

`DEPLOY_TRANSPORT=local`: ssh és rsync-cél nélkül a „szerver” a helyi gép és egy scratch `DEPLOY_DIR` (ugyanaz a
távoli szkript fut, `bash -s`-sel); a helyi docker-démon a „szerveré” is, ezért az átvitel kimarad (a címke már
megvan). A cél egy scratch könyvtár (útvonallal megadva), egy szabad port, alhálózat és projektnév kell:

```
D=/tmp/media-proba; T=/tmp/media-proba-cel
install -d $D/data/demo && install -d -m 0700 $D/secrets $T
printf '%s\n' DEPLOY_TRANSPORT=local DEPLOY_DIR=$D > $T/.env
(cd server && pnpm -w keys demo --kid p1 --write $D/secrets/apps.json >/dev/null) && chmod 0400 $D/secrets/apps.json
printf '%s\n' MEDIA_ROOT=$D/data APPS_JSON=./secrets/apps.json BIND=127.0.0.1 PORT=10190 \
  NET_SUBNET=172.29.191.0/24 NET_GATEWAY=172.29.191.1 COMPOSE_PROJECT_NAME=media-server-proba > $D/.env
deploy/deploy.sh $T [--dry-run | --rollback | --reload-config]
(cd $D && IMAGE_TAG=x docker compose down -v)
```
