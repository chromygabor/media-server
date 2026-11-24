# media-server

Védett médiaszerver (nginx + njs) és a kliensoldali csomagja, `@chromygabor/media-sdk`. Egy pnpm-workspace:

```
packages/media-sdk/   @chromygabor/media-sdk – a protokoll nyilvános szerződése (SPEC.md), aláíró, ./testing, CLI
server/               @chromygabor/media-server (private) – a termék: Dockerfile (saját image), nginx, njs,
                      compose.yaml (helyi futtatás, teszt), tesztek, mintamédia
deploy/     a szerveres telepítés: compose.yaml (a kész image), .env-minta, host-blokk, deploy.sh,
                      üzemeltetői kézikönyv (README.md)
docs/                 tervek és döntések (a monorepóból kiemelve, ill. átmásolva 2026-11-24)
```

A szerver a csomagot `workspace:*`-ként használja; az njs ↔ SDK paritást (közös vektorok, `validateApps`,
hamis szerver, docker-teszt) egy CI-futás ellenőrzi.

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
pnpm server:deploy [--dry-run]   # telepítés a szerverre (deploy/deploy.sh; --rollback, --reload-config, --help)
```

Helyi futtatás: `server/README.md` „Helyi futtatás”. Telepítés, visszaállás, kulcsforgatás: `deploy/README.md`.

## Titkok

A `server/secrets/` és a `deploy/*/secrets/` tartalma (az `apps.json`-ok) és a `.env`-fájlok gitignore-oltak; kulcs
soha nem kerül a repóba.
