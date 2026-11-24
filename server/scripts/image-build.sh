#!/usr/bin/env bash
# A médiaszerver image-ének építése a server/Dockerfile-ból (kiemelési terv WP49).
#
#   server/scripts/image-build.sh [--allow-dirty] [--tag <név:címke>] [--quiet]     (gyökérből: pnpm image:build)
#
# Címke (alap): media-server:<a server/package.json verziója>-<rövid SHA>. Piszkos munkafánál (követett változás vagy
# nem ignorált új fájl) megtagad; --allow-dirty mellett a címke …-dirty-<UTC időbélyeg>, a revision címke …-dirty.
# --tag: tetszőleges címke (pl. media-server:dev a helyi futtatáshoz és a docker-teszthez); ilyenkor a munkafa
# állapota nem akadály, a revision címke akkor is jelzi a piszkosságot.
# OCI-címkék: org.opencontainers.image.revision (teljes SHA), .version, .source (+ a Dockerfile title/description).
# A kimenet utolsó sora (stdout) a kész címke; a build naplója a stderr-re megy (--quiet: csak hibánál).

set -euo pipefail

APP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE_URL=${IMAGE_SOURCE_URL:-https://github.com/chromygabor/media-server}

ALLOW_DIRTY=0
TAG=""
QUIET=0
usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --tag)
      [[ $# -ge 2 && -n "$2" ]] || { echo "image-build: a --tag értéket vár" >&2; exit 2; }
      TAG=$2
      shift
      ;;
    --tag=*) TAG=${1#--tag=} ;;
    --quiet | -q) QUIET=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "image-build: ismeretlen kapcsoló: $1 (lásd --help)" >&2
      exit 2
      ;;
  esac
  shift
done

die() {
  echo "image-build: HIBA: $*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || die "a docker nincs telepítve"
[[ -f "$APP_DIR/Dockerfile" ]] || die "hiányzik: $APP_DIR/Dockerfile"

version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_DIR/package.json" | head -n 1)
[[ -n "$version" ]] || die "a $APP_DIR/package.json-ban nincs version"

if git -C "$APP_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  sha=$(git -C "$APP_DIR" rev-parse HEAD)
  dirty=$(git -C "$APP_DIR" status --porcelain --untracked-files=normal -- "$(git -C "$APP_DIR" rev-parse --show-toplevel)")
else
  sha=unknown
  dirty="nincs git"
fi
short=${sha:0:7}

revision=$sha
if [[ -n "$dirty" ]]; then
  revision="$sha-dirty"
  if [[ -z "$TAG" ]] && ((!ALLOW_DIRTY)); then
    echo "$dirty" | head -n 20 >&2
    die "a munkafa nem tiszta (fent); commit, vagy --allow-dirty (a címke …-dirty-<időbélyeg> lesz)"
  fi
fi
if [[ -z "$TAG" ]]; then
  TAG="media-server:$version-$short"
  [[ -z "$dirty" ]] || TAG="$TAG-dirty-$(date -u +%Y%m%d%H%M%S)"
fi
[[ "$TAG" =~ ^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "érvénytelen címke: $TAG"

build=(docker build
  --label "org.opencontainers.image.revision=$revision"
  --label "org.opencontainers.image.version=$version"
  --label "org.opencontainers.image.source=$SOURCE_URL"
  -t "$TAG" "$APP_DIR")
if ((QUIET)); then
  log=$("${build[@]}" 2>&1) || {
    echo "$log" >&2
    die "a docker build nem sikerült ($TAG)"
  }
else
  "${build[@]}" >&2 || die "a docker build nem sikerült ($TAG)"
fi
echo "$TAG"
