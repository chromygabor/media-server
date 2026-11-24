# media-server

Védett médiaszerver (nginx + njs) és a kliensoldali csomagja, `@chromygabor/media-sdk`. Egy pnpm-workspace:

```
packages/media-sdk/   @chromygabor/media-sdk – a protokoll nyilvános szerződése (SPEC.md), aláíró, ./testing, CLI
server/               @chromygabor/media-server (private) – nginx, njs, compose.yaml, deploy/, tesztek, mintamédia
docs/                 tervek és döntések (a monorepóból kiemelve 2026-11-24)
```

A szerver a csomagot `workspace:*`-ként használja; az njs ↔ SDK paritást (közös vektorok, `validateApps`,
hamis szerver, docker-teszt) egy CI-futás ellenőrzi.

## Előfeltételek

Node ≥ 22, pnpm 12 (`packageManager`), a docker-teszthez és a mintamédiához docker + `docker compose` és ffmpeg; a
deployhoz rsync és ssh.

## Parancsok (a repó gyökeréből)

```
pnpm install
pnpm build                 # a csomag dist/-je (a szerver tesztjei és a keys/sign ebből futnak)
pnpm typecheck             # = pnpm -r typecheck
pnpm lint
pnpm test                  # docker nélküli tesztek
pnpm test:docker           # a szerver docker-integrációs tesztje (docker + ffmpeg kell; hiányukban kihagy)
pnpm --filter @chromygabor/media-sdk check:standalone   # a csomag tarballja egy üres projektben
pnpm dev-media             # szintetikus mintamédia a server/dev-media/ alá (helyi futtatáshoz)
pnpm keys <app> …          # kulcsgenerálás (media-keys; üzemeltetői eszköz), munkakönyvtár: server/
pnpm sign <app> <assetKey> # próbalink a server/secrets/apps.local.json-ból (media-sign)
pnpm server:deploy [--dry-run]   # telepítés (server/deploy/deploy.sh)
```

Helyi futtatás: `server/README.md` „Helyi futtatás”.

## Titkok

A `server/secrets/` tartalma (az `apps.json`-ok) és a `.env`-fájlok gitignore-oltak; kulcs soha nem kerül a repóba.
