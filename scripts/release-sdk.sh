#!/usr/bin/env bash
# A @chromygabor/media-sdk kiadásának előkészítése: tesztelt tarball GitHub Release-mellékletnek, npm-regisztry nélkül.
#
#   scripts/release-sdk.sh [--tag]          (gyökérből: pnpm release:sdk [--tag])
#
# 1. Tiszta munkafa kell (követett változás és követetlen fájl sincs; a gitignore-olt kimenet nem számít).
# 2. Build (pnpm build), a csomag tesztjei (pnpm --filter @chromygabor/media-sdk test).
# 3. pnpm pack a dist-release/ alá (gitignore-olt): chromygabor-media-sdk-<verzió>.tgz. A pnpm pack determinisztikus
#    (rögzített időbélyegek), ugyanabból a forrásból bájtra ugyanaz a fájl.
# 4. check:standalone PONTOSAN ezen a fájlon (MEDIA_SDK_TARBALL): telepítés egy üres projektbe, ESM-, CJS-, ./testing-
#    és bin-próba. A kiadás melléklete így maga a kipróbált tarball.
# 5. Kiírja a fájl sha256-ját és a sha512 integrity-t (ahogy a pnpm-lock.yaml mutatja), a CHANGELOG szakaszát a
#    dist-release/sdk-v<verzió>-notes.md-be teszi (a Release szövegének), és utána a munkafát újra ellenőrzi.
# 6. --tag: helyben létrehozza az annotált sdk-v<verzió> taget a HEAD-re (ha már létezik, hiba). Nélküle nincs tag.
# 7. Kiírja a kézi lépéseket (push, Release, feltöltés, ellenőrzés) és a fogyasztó függőségsorát.
#
# A szkript soha nem pushol, és nem ér el hálózatot: a tag és a Release feltöltése a tulajdonos kézi lépése.

set -euo pipefail

usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

TAG=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "release-sdk: ismeretlen kapcsoló: $1 (lásd --help)" >&2
      exit 2
      ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PKG_DIR=packages/media-sdk
OUT_DIR=dist-release

die() {
  echo "✗ release-sdk: $*" >&2
  exit 1
}
step() { echo "▸ $*"; }

dirty_check() {
  local status
  status="$(git status --porcelain --untracked-files=all)"
  [[ -z "$status" ]] || {
    echo "$status" >&2
    die "$1"
  }
}

# --- 1. Tiszta munkafa, verzió, tag ------------------------------------------------------------------------------
dirty_check "a munkafa nem tiszta (fent); a kiadás csak commitolt állapotból készülhet"

NAME="$(node -p "require('./$PKG_DIR/package.json').name")"
VERSION="$(node -p "require('./$PKG_DIR/package.json').version")"
[[ "$NAME" == "@chromygabor/media-sdk" ]] || die "a csomag neve $NAME, nem @chromygabor/media-sdk"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "a verzió ($VERSION) nem X.Y.Z alakú"
TAG_NAME="sdk-v$VERSION"
FILE="chromygabor-media-sdk-$VERSION.tgz"
HEAD_SHA="$(git rev-parse HEAD)"

grep -q "^## \[$VERSION\]" "$PKG_DIR/CHANGELOG.md" || die "a CHANGELOG-ban nincs „## [$VERSION]” szakasz"

if git rev-parse -q --verify "refs/tags/$TAG_NAME" >/dev/null; then
  TAG_SHA="$(git rev-parse "$TAG_NAME^{commit}")"
  if [[ "$TAG" == 1 ]]; then
    die "a(z) $TAG_NAME tag már létezik (→ ${TAG_SHA:0:7}); egy kiadott verzió nem készül újra, emeld a verziót"
  fi
  [[ "$TAG_SHA" == "$HEAD_SHA" ]] \
    || die "a(z) $TAG_NAME tag már létezik, és nem a HEAD-re mutat (→ ${TAG_SHA:0:7}); emeld a verziót"
fi

# A repository mezőből: owner/repo a letöltési URL-hez.
REPO_URL="$(node -p "require('./$PKG_DIR/package.json').repository.url")"
GH_REPO="$(sed -nE 's#^(git\+)?https://github\.com/([^/]+/[^/.]+)(\.git)?$#\2#p' <<<"$REPO_URL")"
[[ -n "$GH_REPO" ]] || die "a repository.url ($REPO_URL) nem github.com-os https-cím"
DOWNLOAD_URL="https://github.com/$GH_REPO/releases/download/$TAG_NAME/$FILE"

echo "$NAME $VERSION (HEAD ${HEAD_SHA:0:7}) → $OUT_DIR/$FILE"

# --- 2. Build és tesztek -----------------------------------------------------------------------------------------
step "build"
pnpm --silent build >/dev/null
step "a csomag tesztjei"
pnpm --silent --filter "$NAME" test

# --- 3. Pack -----------------------------------------------------------------------------------------------------
step "pack → $OUT_DIR/"
mkdir -p "$OUT_DIR"
rm -f -- "$OUT_DIR/$FILE"
(cd "$PKG_DIR" && pnpm pack --pack-destination "$ROOT/$OUT_DIR" >/dev/null)
[[ -f "$OUT_DIR/$FILE" ]] || die "a pnpm pack nem a várt fájlt készítette ($OUT_DIR/$FILE)"

# --- 4. check:standalone pontosan ezen a fájlon --------------------------------------------------------------------
step "check:standalone a kiadandó tarballon"
MEDIA_SDK_TARBALL="$ROOT/$OUT_DIR/$FILE" pnpm --silent --filter "$NAME" check:standalone

# --- 5. Hash-ek, kiadási jegyzet ---------------------------------------------------------------------------------
SHA256="$(sha256sum "$OUT_DIR/$FILE" | cut -d' ' -f1)"
INTEGRITY="$(node -e '
  const { createHash } = require("node:crypto");
  const data = require("node:fs").readFileSync(process.argv[1]);
  console.log("sha512-" + createHash("sha512").update(data).digest("base64"));
' "$OUT_DIR/$FILE")"

NOTES="$OUT_DIR/$TAG_NAME-notes.md"
awk -v ver="$VERSION" '
  index($0, "## [" ver "]") == 1 { on = 1; next }
  on && /^## \[/ { exit }
  on { print }
' "$PKG_DIR/CHANGELOG.md" >"$NOTES.body"
{
  echo "Telepítés (pnpm vagy npm), a package.json-ban:"
  echo
  echo '```json'
  echo "\"$NAME\": \"$DOWNLOAD_URL\""
  echo '```'
  echo
  echo "sha256: \`$SHA256\`"
  echo
  cat "$NOTES.body"
} >"$NOTES"
rm -f -- "$NOTES.body"

dirty_check "a build vagy a tesztek követett fájlt változtattak (fent); javítsd, és futtasd újra"

# --- 6. Tag (csak --tag) -----------------------------------------------------------------------------------------
if [[ "$TAG" == 1 ]]; then
  git tag -a "$TAG_NAME" -m "$NAME $VERSION" "$HEAD_SHA"
  TAG_STATE="létrehozva helyben: $TAG_NAME → ${HEAD_SHA:0:7} (nincs pusholva)"
elif git rev-parse -q --verify "refs/tags/$TAG_NAME" >/dev/null; then
  TAG_STATE="már létezik helyben: $TAG_NAME → ${HEAD_SHA:0:7}"
else
  TAG_STATE="nincs (futtasd újra --tag-gel, vagy: git tag -a $TAG_NAME -m \"$NAME $VERSION\" ${HEAD_SHA:0:7})"
fi

# --- 7. Összegzés és a kézi lépések ------------------------------------------------------------------------------
cat <<EOF

✓ $NAME $VERSION kész a kiadásra
  fájl:      $OUT_DIR/$FILE
  sha256:    $SHA256
  integrity: $INTEGRITY
  jegyzet:   $NOTES
  tag:       $TAG_STATE

Kézi lépések (a szkript nem pushol):
  1. a kiadási commit legyen fent:  git push origin main
  2. a tag:                          git push origin $TAG_NAME
  3. GitHub Release a tagre, a fájl mellékletként:
       webes felület: https://github.com/$GH_REPO/releases/new?tag=$TAG_NAME
         cím: $NAME $VERSION; szöveg: $NOTES; melléklet: $OUT_DIR/$FILE
       vagy gh-val:   gh release create $TAG_NAME $OUT_DIR/$FILE --title "$NAME $VERSION" --notes-file $NOTES
  4. ellenőrzés: curl -fsSL $DOWNLOAD_URL | sha256sum
       → $SHA256

A fogyasztó függősége (package.json, pnpm és npm):
  "$NAME": "$DOWNLOAD_URL"
A lockfile-ban a tarball integrity-je: $INTEGRITY
EOF
