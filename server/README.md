# @workspace/media-server

Védett médiaszerver: a hivatalos `nginx` image (tag + digest rögzítve, njs 1.0.2) + egy njs-modul, amely a
Bunny V2 directory-tokent (`kid`, `u` kiegészítéssel) ellenőrzi, és az nginx statikus motorjával szolgál ki
(Range, ETag, sendfile). Tervek: a terv 4.1–4.4, 7.2–7.3,
az implementációs terv WP2–WP4.
Ügyfél-appból nem importál; a CLI-k és a tesztek a `@workspace/media-token`-t használják.

```
compose.yaml              egy szolgáltatás (media), read_only, 127.0.0.1:10090, rögzített alhálózat (real_ip)
nginx/nginx.conf          njs-modul, types-tábla, real_ip, js_preload_object apps
nginx/media.conf          js_set változók, CORS / CORP / Cache-Control, limit_*, JSON-napló (token nélkül), /healthz
nginx/templates/          realip.conf.template (az image envsubst-je: set_real_ip_from ${NET_GATEWAY})
njs/media.js              token-ellenőrzés (= media-token verifySignedPath: status ÉS reason), js_set-kimenetek
njs/check-apps.js         az apps.json tartalmi ellenőrzése a konténerben (njs CLI)
scripts/keys-new.ts       kulcsgenerálás
scripts/sign.ts           próbalink aláírása
secrets/                  gitignore-olt (apps.local.json, apps.prod.json)
test/                     docker nélküli tesztek (pnpm test); fixtures/apps.test.json: CSAK TESZT kulcsok
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

## Élesítés (media-host)

A WP4 tölti ki (deploy, host-nginx blokk, egyszeri sudo-lépések, rotáció).
