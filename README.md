# media-server

Védett médiaszerver (nginx + njs) és a kliensoldali csomagja, `@chromygabor/media-sdk`. Egy pnpm-workspace:

```
packages/media-sdk/   @chromygabor/media-sdk – a protokoll nyilvános szerződése (SPEC.md), aláíró, ./testing, CLI
server/               @chromygabor/media-server (private) – a termék: Dockerfile (saját image), nginx, njs,
                      compose.yaml (helyi futtatás, teszt), tesztek, mintamédia
deploy/               generikus telepítés: deploy.sh, compose.yaml (a kész image), .env-minták, host-blokk minta,
                      üzemeltetői kézikönyv (README.md)
deploy/<cél>/         gitignore-olt: egy célgép saját adatai (.env: DEPLOY_HOST/USER/DIR; secrets/apps.json)
```

A szerver a csomagot `workspace:*`-ként használja; az njs ↔ SDK paritást (közös vektorok, `validateApps`,
hamis szerver, docker-teszt) a repó kapuja ellenőrzi (`pnpm test`, `check:standalone`, `pnpm test:docker`), és minden
deploy előtt a `deploy.sh` a kiszállítandó image-en. CI nincs.

## Telepítés (a csomag fogyasztóinak)

A `@chromygabor/media-sdk` nincs npm-regisztryben. Minden verzió egy GitHub Release melléklete (tag:
`sdk-v<verzió>`), és a fogyasztó URL-függőségként telepíti, pnpm-mel és npm-mel egyformán:

```json
{
  "dependencies": {
    "@chromygabor/media-sdk": "https://github.com/chromygabor/media-server/releases/download/sdk-v1.0.0/chromygabor-media-sdk-1.0.0.tgz"
  }
}
```

vagy parancssorból: `pnpm add <URL>` / `npm install <URL>`. Részletek (frissítés, mit rögzít a lockfile):
[`packages/media-sdk/README.md`](packages/media-sdk/README.md) „Telepítés”.

## Kiadás (üzemeltető)

```
pnpm release:sdk           # tiszta munkafa → build, tesztek, pack a dist-release/ alá, check:standalone ezen a fájlon,
                           # sha256 + integrity, Release-jegyzet; a kézi lépéseket kiírja (soha nem pushol)
pnpm release:sdk --tag     # ugyanez, és helyben létrehozza az annotált sdk-v<verzió> taget
```

Előtte: a verzió a `packages/media-sdk/package.json`-ban, a CHANGELOG `## [<verzió>]` szakasza, commit. Utána kézzel:
`git push origin main`, `git push origin sdk-v<verzió>`, GitHub Release a tagre a `dist-release/` `.tgz`-jével
mellékletként (webes felület vagy `gh release create`), végül a letöltési URL sha256-jának ellenőrzése. A szkript
mindezt a pontos parancsokkal kiírja.

## Előfeltételek

Node ≥ 22, pnpm 12 (`packageManager`), az image-hez, a docker-teszthez és a mintamédiához docker + `docker compose` és
ffmpeg; a deployhoz rsync, ssh és gzip.

## Parancsok (a repó gyökeréből)

```
pnpm install
pnpm build                 # a csomag dist/-je (a szerver tesztjei és a keys/sign ebből futnak)
pnpm typecheck             # = pnpm -r typecheck
pnpm lint
pnpm test                  # docker nélküli tesztek
pnpm image:build           # a szerver image-e: media-server:<verzió>-<SHA> + OCI-címkék (tiszta munkafáról)
pnpm test:docker           # image-építés (media-server:dev) + docker-integrációs teszt ezen az image-en
                           # (docker + ffmpeg kell; hiányukban kihagy, MEDIA_DOCKER_REQUIRED=1 mellett hiba)
pnpm --filter @chromygabor/media-sdk check:standalone   # a csomag tarballja egy üres projektben
pnpm dev-media             # szintetikus mintamédia a server/dev-media/ alá (helyi futtatáshoz)
pnpm keys <app> …          # kulcsgenerálás (media-keys; üzemeltetői eszköz), munkakönyvtár: server/
pnpm sign <app> <assetKey> # próbalink a server/secrets/apps.local.json-ból (media-sign)
pnpm server:deploy <cél> [--dry-run]   # telepítés a deploy/<cél>/ célgépére (deploy/deploy.sh; --rollback, --reload-config, --help)
```

Helyi futtatás: `server/README.md` „Helyi futtatás”. Telepítés, visszaállás, kulcsforgatás: `deploy/README.md`.

## Titkok

A `server/secrets/` tartalma, a `.env`-fájlok és a teljes `deploy/<cél>/` (a célgép adatai és az `apps.json` helyi
példánya) gitignore-oltak; kulcs és telepítési adat soha nem kerül a repóba.

## Tervezési előzmények

A kommentekben és a CHANGELOG-ban álló `WPn` / `Dn` / „terv …” hivatkozások a fejlesztés belső tervdokumentumaira
utalnak; ezek nem részei a repónak. A normatív leírás a [`SPEC.md`](packages/media-sdk/SPEC.md), az üzemeltetés a
[`deploy/README.md`](deploy/README.md).

## Licenc

[MIT](LICENSE) – az egész repó (a `@chromygabor/media-sdk` és a szerver is).
