#!/usr/bin/env bash
# A médiaszerver telepítése a szerverre: tesztelt image, regisztry nélkül (kiemelési terv WP49; terv 7.3).
#
#   deploy/deploy.sh [--dry-run] [--allow-dirty] [--keep N]      (gyökérből: pnpm server:deploy …)
#   deploy/deploy.sh --rollback [--dry-run]                       vissza a PREVIOUS_IMAGE_TAG-re
#   deploy/deploy.sh --reload-config [--dry-run]                  új apps.json élesítése, image-csere nélkül
#
# Deploy: 1. helyben image a server/Dockerfile-ból (server/scripts/image-build.sh: media-server:<verzió>-<SHA>,
# OCI-címkék; piszkos munkafánál megtagad, --allow-dirty nélkül); 2. a docker-teszt EZEN az image-en
# (MEDIA_IMAGE=…, MEDIA_DOCKER_REQUIRED=1): csak tesztelt image megy ki; 3. a szerver ellenőrzése (csak olvasás);
# 4. átvitel: docker save | gzip | ssh … docker load (kimarad, ha a címke ugyanazzal a tartalommal már ott van); 5. rsync CSAK a
# compose.yaml-ra (a régi compose.yaml.prev néven marad); 6. a szerveren az ÚJ image-dzsel és a mostani apps.json-nal,
# eldobható konténerben: compose config, check-apps.js, nginx -t (a futó konténer közben fut); 7. váltás: a .env
# IMAGE_TAG-je az új, a PREVIOUS_IMAGE_TAG a régi címke (atomikusan; a .env egyetlen írása), up -d --wait, /healthz;
# hibánál a .env és a konténer vissza a régi címkére; 8. a régi image-ek takarítása (a mostani, az előző és a
# legújabb N marad; --keep N, alap 3, N >= 2).
# --rollback: check-apps.js + nginx -t az előző image-dzsel, majd a két címke cseréje, up -d --wait, /healthz.
# --reload-config: check-apps.js + nginx -t a futó címkével, up -d --wait, majd ha az apps.json inode-ja változott
# (atomikus csere) restart, különben nginx -s reload; /healthz. A kulcsforgatás rutinlépése.
# --dry-run: a helyi lépések (deploynál építés és teszt), a szerver ellenőrzése és a terv; a szerveren semmi nem változik.
# A .env, a secrets/ és a data/ a szerveren marad; a szkript ezekbe nem ír és nem töröl (kivétel: a 7. lépés két sora).
# Környezet: DEPLOY_HOST (media-host), DEPLOY_USER (deploy), DEPLOY_DIR (/srv/media-server), DEPLOY_SSH_OPTS,
# DEPLOY_TRANSPORT (ssh; a főpróbához local: ssh és távoli gép nélkül, a „szerver” a helyi gép és a DEPLOY_DIR).
# Sudo nincs benne; az egyszeri sudo-lépések a deploy/README.md-ben.

set -euo pipefail

DEPLOY_HOST=${DEPLOY_HOST:-media-host}
DEPLOY_USER=${DEPLOY_USER:-deploy}
DEPLOY_DIR=${DEPLOY_DIR:-/srv/media-server}
DEPLOY_SSH_OPTS=${DEPLOY_SSH_OPTS:-"-o BatchMode=yes -o ConnectTimeout=10"}
DEPLOY_TRANSPORT=${DEPLOY_TRANSPORT:-ssh}

usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

MODE=deploy
DRY_RUN=0
ALLOW_DIRTY=0
KEEP=3
set_mode() {
  if [[ "$MODE" != deploy ]]; then
    echo "deploy: a --rollback és a --reload-config kizárja egymást" >&2
    exit 2
  fi
  MODE=$1
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run | -n) DRY_RUN=1 ;;
    --rollback) set_mode rollback ;;
    --reload-config) set_mode reload ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --keep)
      [[ $# -ge 2 ]] || {
        echo "deploy: a --keep számot vár" >&2
        exit 2
      }
      KEEP=$2
      shift
      ;;
    --keep=*) KEEP=${1#--keep=} ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "deploy: ismeretlen kapcsoló: $1 (lásd --help)" >&2
      exit 2
      ;;
  esac
  shift
done
[[ "$KEEP" =~ ^[0-9]+$ ]] && ((KEEP >= 2)) || {
  echo "deploy: a --keep legalább 2 legyen ($KEEP)" >&2
  exit 2
}
if [[ "$MODE" != deploy ]] && ((ALLOW_DIRTY)); then
  echo "deploy: az --allow-dirty csak deploynál értelmes (ott van építés)" >&2
  exit 2
fi

die() {
  echo "deploy: HIBA: $*" >&2
  exit 1
}
step() { echo "==> $*"; }

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SRC_DIR="$ROOT/deploy/media-host"
SERVER_DIR="$ROOT/server"
TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"
read -r -a SSH_OPTS <<<"$DEPLOY_SSH_OPTS"

[[ "$DEPLOY_DIR" == /* && "$DEPLOY_DIR" != / ]] || die "a DEPLOY_DIR abszolút útvonal legyen, és ne a / ($DEPLOY_DIR)"
[[ "$DEPLOY_DIR" != *[[:space:]]* ]] || die "a DEPLOY_DIR nem tartalmazhat szóközt ($DEPLOY_DIR)"
case "$DEPLOY_TRANSPORT" in
  ssh) WHERE="$TARGET:$DEPLOY_DIR" ;;
  local) WHERE="(helyi főpróba) $DEPLOY_DIR" ;;
  *) die "a DEPLOY_TRANSPORT ssh vagy local lehet ($DEPLOY_TRANSPORT)" ;;
esac

# --- helyi előfeltételek ----------------------------------------------------------------------------------------
need=(rsync)
[[ "$DEPLOY_TRANSPORT" == ssh ]] && need+=(ssh)
[[ "$MODE" == deploy ]] && need+=(docker git gzip pnpm)
for cmd in "${need[@]}"; do
  command -v "$cmd" >/dev/null 2>&1 || die "a(z) '$cmd' nincs telepítve a fejlesztőgépen"
done
for f in "$SRC_DIR/compose.yaml" "$SERVER_DIR/Dockerfile" "$SERVER_DIR/scripts/image-build.sh"; do
  [[ -f "$f" ]] || die "hiányzik a forrásfájl: $f"
done

# A „távoli” parancs: ssh-n, vagy a főpróbában helyben (ugyanaz a bash -s szkript).
ssh_run() {
  if [[ "$DEPLOY_TRANSPORT" == local ]]; then
    bash -c "$*"
  else
    ssh "${SSH_OPTS[@]}" "$TARGET" "$@"
  fi
}

# A távoli szkript (bash -s) első argumentuma a fázis, a második a DEPLOY_DIR, a többi fázisfüggő.
remote() {
  local args
  args=$(printf '%q ' "$@")
  ssh_run "bash -s -- $args" <<'REMOTE'
set -euo pipefail
phase=$1
dir=$2
shift 2
# A címkét mindig kifejezetten adjuk át a compose-nak; egy örökölt változó ne szóljon bele.
unset IMAGE_TAG PREVIOUS_IMAGE_TAG
die() { echo "deploy (szerver): HIBA: $*" >&2; exit 1; }
note() { echo "--> $*"; }
inode() { if [[ -e "$1" ]]; then stat -c %i "$1"; else echo none; fi; }
valid_tag() { [[ "$1" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; }
# A .env egy változójának (utolsó) értéke, idézőjelek nélkül (üres, ha nincs).
env_get() {
  local v
  v=$(sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$dir/.env" | tail -n 1)
  v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
  printf '%s\n' "$v"
}
# Útvonal a .env-ből; relatív útvonal a DEPLOY_DIR-hez képest.
env_path() {
  local v
  v=$(env_get "$1")
  [[ -n "$v" ]] || die "a .env-ben nincs $1"
  [[ "$v" == /* ]] || v="$dir/${v#./}"
  printf '%s\n' "$v"
}
has_image() { docker image inspect "media-server:$1" >/dev/null 2>&1; }
# Tartalmi ujjlenyomat (a revision címke + a rétegek diffID-jei): a docker save / load után és eltérő image-tárral
# (overlay2 / containerd) is ugyanaz, az .Id nem feltétlenül.
fingerprint() {
  local out
  out=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}} {{range .RootFS.Layers}}{{.}} {{end}}' "$1" 2>/dev/null) || return 0
  printf '%s' "$out" | sha256sum | cut -d' ' -f1
}
# docker compose a megadott címkével (a .env többi értéke a fájlból).
dc() { local t=$1; shift; IMAGE_TAG=$t docker compose "$@"; }
# A .env IMAGE_TAG / PREVIOUS_IMAGE_TAG sora: ideiglenes fájl a DEPLOY_DIR-ben, ugyanazzal a jogosultsággal, majd mv
# (atomikus); a többi sor változatlan, a hiányzó sor a végére kerül.
set_tags() {
  local new=$1 prev=$2 tmp
  valid_tag "$new" || die "érvénytelen címke: '$new'"
  [[ -z "$prev" ]] || valid_tag "$prev" || die "érvénytelen előző címke: '$prev'"
  tmp=$(mktemp "$dir/.env.deploy.XXXXXX")
  chmod "$(stat -c %a "$dir/.env")" "$tmp"
  if ! awk -v n="$new" -v p="$prev" '
      /^[[:space:]]*IMAGE_TAG[[:space:]]*=/ { if (!a) print "IMAGE_TAG=" n; a = 1; next }
      /^[[:space:]]*PREVIOUS_IMAGE_TAG[[:space:]]*=/ { if (!b) print "PREVIOUS_IMAGE_TAG=" p; b = 1; next }
      { print }
      END { if (!a) print "IMAGE_TAG=" n; if (!b) print "PREVIOUS_IMAGE_TAG=" p }' "$dir/.env" >"$tmp"; then
    rm -f "$tmp"
    die "a .env átírása nem sikerült (változatlan)"
  fi
  mv -f "$tmp" "$dir/.env"
  note ".env: IMAGE_TAG=$new, PREVIOUS_IMAGE_TAG=${prev:-(üres)}"
}
healthz() {
  local t=$1 hp code=""
  hp=$(dc "$t" port media 80 2>/dev/null || true)
  [[ -n "$hp" ]] || { echo "deploy (szerver): a media 80-as portja nincs kiadva" >&2; return 1; }
  for _ in $(seq 1 15); do
    code=$(curl -sS -o /dev/null -w '%{http_code}' "http://$hp/healthz" 2>/dev/null || true)
    [[ "$code" == 204 ]] && break
    sleep 1
  done
  [[ "$code" == 204 ]] || { echo "deploy (szerver): a /healthz válasza $code (várt: 204) – napló: docker compose logs --tail 50 media" >&2; return 1; }
  note "/healthz 204 ($hp)"
}
# Ellenőrzés a megadott image-dzsel, eldobható konténerben (a futó konténert nem érinti).
verify() {
  local t=$1
  cd "$dir"
  has_image "$t" || die "nincs ilyen image a szerveren: media-server:$t"
  local keep="a futó konténer és a .env változatlan"
  note "docker compose config -q (media-server:$t)"
  dc "$t" config -q || die "a docker compose config hibás ($keep)"
  note "check-apps.js (eldobható konténerben, media-server:$t)"
  dc "$t" run --rm --no-deps -T -e NGINX_ENTRYPOINT_QUIET_LOGS=1 media njs -q -m -p /etc/nginx/njs /etc/nginx/njs/check-apps.js ||
    die "a check-apps.js szerint az apps.json hibás a media-server:$t-hez ($keep)"
  note "nginx -t (eldobható konténerben, media-server:$t)"
  dc "$t" run --rm --no-deps -T -e NGINX_ENTRYPOINT_QUIET_LOGS=1 media nginx -c /etc/nginx/media/nginx.conf -t ||
    die "az nginx -t elbukott a media-server:$t-vel ($keep)"
}
# Váltás a megadott címkére (ugyanarra is: akkor a .env nem változik, és újratöltés / restart jön).
switch() {
  local t=$1 old_compose_inode=$2 cur prev before after ok=1
  cd "$dir"
  cur=$(env_get IMAGE_TAG)
  prev=$(env_get PREVIOUS_IMAGE_TAG)
  before=$(dc "${cur:-$t}" ps -q media 2>/dev/null || true)
  [[ "$t" == "$cur" ]] || set_tags "$t" "$cur"
  note "docker compose up -d --wait (media-server:$t)"
  if dc "$t" up -d --wait; then
    after=$(dc "$t" ps -q media)
    if [[ -n "$before" && "$before" == "$after" ]]; then
      local apps host_apps_inode ctr_apps_inode new_compose_inode
      apps=$(env_path APPS_JSON)
      host_apps_inode=$(inode "$apps")
      ctr_apps_inode=$(dc "$t" exec -T media stat -c %i /etc/nginx/secrets/apps.json)
      new_compose_inode=$(inode "$dir/compose.yaml")
      if [[ "$new_compose_inode" != "$old_compose_inode" || "$host_apps_inode" != "$ctr_apps_inode" ]]; then
        note "a konténer maradt, de a compose.yaml vagy az apps.json inode-ja változott: docker compose restart media"
        dc "$t" restart media || ok=0
        if ((ok)); then dc "$t" up -d --wait || ok=0; fi
      else
        note "a konténer maradt: nginx -s reload"
        dc "$t" exec -T media nginx -c /etc/nginx/media/nginx.conf -s reload || ok=0
      fi
    else
      note "a konténer most jött létre (media-server:$t)"
    fi
    if ((ok)); then healthz "$t" || ok=0; fi
  else
    ok=0
  fi
  if ((!ok)); then
    if [[ "$t" != "$cur" && -n "$cur" ]]; then
      echo "deploy (szerver): a váltás nem sikerült; vissza a media-server:$cur-ra" >&2
      set_tags "$cur" "$prev"
      dc "$cur" up -d --wait || true
      healthz "$cur" || true
      die "a media-server:$t nem indult el rendben; a futó image ismét media-server:$cur (napló: docker compose logs media)"
    fi
    if [[ -z "$cur" && -f "$dir/compose.yaml.prev" ]]; then
      die "a media-server:$t nem indult el rendben; előző címke nincs (első telepítés). Kézi visszaállás a régi elrendezésre: cd $dir && cp compose.yaml.prev compose.yaml && docker compose up -d --wait"
    fi
    die "a media-server:$t nem indult el rendben (napló: docker compose logs media)"
  fi
  dc "$t" ps media
}

case "$phase" in
  check)
    image=$1
    image_fp=$2
    [[ -d "$dir" ]] || die "$dir nem létezik – egyszeri sudo-lépés: sudo install -d -o $(id -un) -g docker $dir (README)"
    [[ -w "$dir" ]] || die "$dir nem írható a(z) $(id -un) felhasználónak (tulajdonos: $(stat -c %U:%G "$dir"))"
    [[ -f "$dir/.env" ]] || die "$dir/.env hiányzik – kézzel kell létrehozni (README: Első telepítés)"
    [[ -w "$dir/.env" ]] || die "$dir/.env nem írható (a deploy.sh az IMAGE_TAG sort írja)"
    [[ -f "$dir/secrets/apps.json" ]] || die "$dir/secrets/apps.json hiányzik – kézzel kell létrehozni (README: kulcsok)"
    [[ -r "$dir/secrets/apps.json" ]] || die "$dir/secrets/apps.json nem olvasható a(z) $(id -un) felhasználónak"
    apps=$(env_path APPS_JSON)
    root=$(env_path MEDIA_ROOT)
    [[ -f "$apps" ]] || die "a .env APPS_JSON-ja ($apps) nem létező fájl"
    [[ -d "$root" ]] || die "a .env MEDIA_ROOT-ja ($root) nem létező könyvtár (különben a docker root-ként hozná létre)"
    mode=$(stat -c %a "$apps")
    [[ "$mode" == 400 || "$mode" == 600 ]] || echo "deploy (szerver): FIGYELEM: $apps jogosultsága $mode (ajánlott: 0400)" >&2
    command -v docker >/dev/null 2>&1 || die "a docker nincs telepítve"
    docker compose version >/dev/null 2>&1 || die "a 'docker compose' nem érhető el"
    docker info >/dev/null 2>&1 || die "a docker démon nem érhető el a(z) $(id -un) felhasználónak (docker csoport?)"
    command -v curl >/dev/null 2>&1 || die "a curl nincs telepítve (a /healthz-hez kell)"
    cur=$(env_get IMAGE_TAG)
    prev=$(env_get PREVIOUS_IMAGE_TAG)
    echo "compose-inode=$(inode "$dir/compose.yaml")"
    echo "current-tag=$cur"
    echo "previous-tag=$prev"
    echo "has-current=$([[ -n "$cur" ]] && has_image "$cur" && echo yes || echo no)"
    echo "has-previous=$([[ -n "$prev" ]] && has_image "$prev" && echo yes || echo no)"
    if [[ -n "$image" ]]; then
      rfp=$(fingerprint "$image")
      if [[ -z "$rfp" ]]; then echo "image-state=missing"
      elif [[ "$rfp" == "$image_fp" ]]; then echo "image-state=same"
      else echo "image-state=different"; fi
    fi
    running=""
    if [[ -f "$dir/compose.yaml" ]]; then
      running=$(cd "$dir" && IMAGE_TAG=${cur:-none} docker compose ps --format '{{.Image}}' media 2>/dev/null | head -n 1 || true)
    fi
    echo "running-image=$running"
    ;;

  fingerprint)
    fingerprint "$1"
    ;;

  verify)
    verify "$1"
    ;;

  switch)
    switch "$1" "$2"
    ;;

  rollback)
    cd "$dir"
    cur=$(env_get IMAGE_TAG)
    prev=$(env_get PREVIOUS_IMAGE_TAG)
    [[ -n "$prev" ]] || die "a .env-ben nincs PREVIOUS_IMAGE_TAG: nincs mire visszaállni"
    [[ "$prev" != "$cur" ]] || die "a PREVIOUS_IMAGE_TAG és az IMAGE_TAG azonos ($cur)"
    verify "$prev"
    switch "$prev" "$1"
    ;;

  reload)
    cd "$dir"
    cur=$(env_get IMAGE_TAG)
    [[ -n "$cur" ]] || die "a .env-ben nincs IMAGE_TAG – előbb egy deploy kell"
    verify "$cur"
    switch "$cur" "$1"
    ;;

  prune)
    keep=$1
    cd "$dir"
    cur=$(env_get IMAGE_TAG)
    prev=$(env_get PREVIOUS_IMAGE_TAG)
    # Csak a deploy.sh címkéi (<verzió>-<SHA>[-dirty-<időbélyeg>]); a legújabbak elöl.
    mapfile -t tags < <(docker image ls media-server --format '{{.CreatedAt}}|{{.Tag}}' | sort -r | cut -d'|' -f2 |
      grep -E '^[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.-]*-[0-9a-f]{7}(-dirty-[0-9]{14})?$' || true)
    n=0
    for t in "${tags[@]}"; do
      n=$((n + 1))
      if [[ "$t" == "$cur" || "$t" == "$prev" || $n -le $keep ]]; then continue; fi
      if docker image rm "media-server:$t" >/dev/null 2>&1; then note "törölve: media-server:$t"; else note "nem törölhető (használatban?): media-server:$t"; fi
    done
    note "megmaradt: $(docker image ls media-server --format '{{.Tag}}' | grep -E -- '-[0-9a-f]{7}' | tr '\n' ' ')"
    ;;

  *) die "ismeretlen fázis: $phase" ;;
esac
REMOTE
}

kv() { sed -n "s/^$1=//p" <<<"$2" | tail -n 1; }

# --- deploy: image építése és tesztje (helyben) -----------------------------------------------------------------
IMAGE=""
IMAGE_FP=""
TAG=""
if [[ "$MODE" == deploy ]]; then
  [[ -f "$ROOT/packages/media-sdk/dist/index.js" ]] ||
    die "a media-sdk nincs lefordítva (a docker-teszt ebből fut): pnpm install && pnpm build"
  step "image építése (server/Dockerfile)"
  build_args=(--quiet)
  ((ALLOW_DIRTY)) && build_args+=(--allow-dirty)
  IMAGE=$(bash "$SERVER_DIR/scripts/image-build.sh" "${build_args[@]}" | tail -n 1) || exit 1
  [[ "$IMAGE" == media-server:* ]] || die "váratlan image-név: $IMAGE"
  TAG=${IMAGE#media-server:}
  IMAGE_FP=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}} {{range .RootFS.Layers}}{{.}} {{end}}' "$IMAGE" | sha256sum | cut -d' ' -f1)
  echo "    $IMAGE ($(docker image inspect --format '{{.Id}}' "$IMAGE"))"
  echo "    revision: $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")"

  step "docker-teszt az image-en: $IMAGE"
  (cd "$ROOT" && MEDIA_IMAGE="$IMAGE" MEDIA_DOCKER_REQUIRED=1 pnpm --silent --filter @chromygabor/media-server test:docker) ||
    die "a docker-teszt nem zöld a(z) $IMAGE image-en: nem telepítjük"
fi

# --- a szerver ellenőrzése (csak olvasás) -----------------------------------------------------------------------
step "a szerver ellenőrzése: $WHERE"
if [[ "$DEPLOY_TRANSPORT" == ssh ]]; then
  ssh_err=$(ssh_run true 2>&1) ||
    die "nem érem el ssh-n: $TARGET (DEPLOY_HOST / DEPLOY_USER, kulcsos belépés?): ${ssh_err:-ismeretlen hiba}"
fi
check_out=$(remote check "$DEPLOY_DIR" "$IMAGE" "$IMAGE_FP") || exit 1
old_compose_inode=$(kv compose-inode "$check_out")
[[ -n "$old_compose_inode" ]] || die "a szerver ellenőrzése nem adott compose-inode-ot: $check_out"
cur=$(kv current-tag "$check_out")
prev=$(kv previous-tag "$check_out")
running=$(kv running-image "$check_out")
echo "    futó image: ${running:-(nincs)}"
echo "    IMAGE_TAG=${cur:-(nincs)} (image: $(kv has-current "$check_out")), PREVIOUS_IMAGE_TAG=${prev:-(nincs)} (image: $(kv has-previous "$check_out"))"

# --- --rollback / --reload-config -------------------------------------------------------------------------------
if [[ "$MODE" == rollback ]]; then
  [[ -n "$prev" ]] || die "a szerver .env-jében nincs PREVIOUS_IMAGE_TAG: nincs mire visszaállni"
  [[ "$(kv has-previous "$check_out")" == yes ]] || die "a media-server:$prev image nincs a szerveren"
  if ((DRY_RUN)); then
    step "dry-run: a szerveren nem változik semmi. Élesben: check-apps.js + nginx -t a media-server:$prev-vel, majd .env: IMAGE_TAG=$prev, PREVIOUS_IMAGE_TAG=${cur:-(üres)}; up -d --wait, /healthz"
    exit 0
  fi
  step "visszaállás: media-server:${cur:-?} → media-server:$prev"
  remote rollback "$DEPLOY_DIR" "$old_compose_inode"
  step "kész: $WHERE fut: media-server:$prev (előző: ${cur:-nincs})"
  exit 0
fi
if [[ "$MODE" == reload ]]; then
  [[ -n "$cur" ]] || die "a szerver .env-jében nincs IMAGE_TAG – előbb egy deploy kell"
  if ((DRY_RUN)); then
    step "dry-run: a szerveren nem változik semmi. Élesben: check-apps.js + nginx -t a media-server:$cur-ral, up -d --wait, majd restart (új apps.json-inode) vagy nginx -s reload, /healthz"
    exit 0
  fi
  step "konfig újratöltése (media-server:$cur; check-apps.js, nginx -t, reload / restart, healthz)"
  remote reload "$DEPLOY_DIR" "$old_compose_inode"
  step "kész: $WHERE"
  exit 0
fi

# --- deploy: átvitel, compose.yaml, ellenőrzés, váltás ----------------------------------------------------------
state=$(kv image-state "$check_out")
case "$state" in
  same) step "image átvitele: kimarad (a szerveren már megvan: $IMAGE)" ;;
  missing | different)
    if ((DRY_RUN)); then
      step "image átvitele (dry-run): $IMAGE kellene ($state; docker save | gzip | docker load)"
    else
      step "image átvitele: docker save | gzip | ssh … docker load ($IMAGE; $state)"
      docker save "$IMAGE" | gzip -1 | ssh_run 'gunzip | docker load'
      rfp=$(remote fingerprint "$DEPLOY_DIR" "$IMAGE")
      [[ "$rfp" == "$IMAGE_FP" ]] || die "az átvitt image tartalma eltér a helyitől (ujjlenyomat: ${rfp:-nincs} ≠ $IMAGE_FP)"
    fi
    ;;
  *) die "a szerver ellenőrzése nem adott image-state-et: $check_out" ;;
esac

# --checksum: csak tartalmi változásnál íródik újra (új inode is csak akkor); a régi példány compose.yaml.prev;
# -t + --chmod: a tulajdonos / csoport a szerveré marad.
RSYNC=(rsync -t --checksum --chmod=F644 --backup --suffix=.prev --itemize-changes)
if [[ "$DEPLOY_TRANSPORT" == ssh ]]; then
  RSYNC+=(-e "ssh ${DEPLOY_SSH_OPTS}")
  DEST="$TARGET:$DEPLOY_DIR/compose.yaml"
else
  DEST="$DEPLOY_DIR/compose.yaml"
fi
mode_note=""
if ((DRY_RUN)); then
  RSYNC+=(--dry-run)
  mode_note=" (dry-run)"
fi
step "rsync${mode_note}: compose.yaml"
"${RSYNC[@]}" "$SRC_DIR/compose.yaml" "$DEST"

if ((DRY_RUN)); then
  same_note=""
  [[ "$TAG" == "$cur" ]] && same_note="   (változatlan: ugyanaz a címke)"
  step "dry-run: a szerveren nem változott semmi. Élesben ezután (a $DEPLOY_DIR-ben):"
  cat <<EOF
    IMAGE_TAG=$TAG docker compose config -q
    IMAGE_TAG=$TAG docker compose run --rm --no-deps -T media njs -q -m -p /etc/nginx/njs /etc/nginx/njs/check-apps.js
    IMAGE_TAG=$TAG docker compose run --rm --no-deps -T media nginx -c /etc/nginx/media/nginx.conf -t
    .env: IMAGE_TAG=$TAG, PREVIOUS_IMAGE_TAG=${cur:-(üres)}$same_note
    docker compose up -d --wait        # ha a konténer marad: restart (új inode) vagy nginx -s reload
    curl http://<docker compose port media 80>/healthz   # 204; hibánál vissza a(z) ${cur:-régi} címkére
    takarítás: a media-server:* közül a mostani, az előző és a legújabb $KEEP marad
EOF
  exit 0
fi

step "a szerveren: ellenőrzés az új image-dzsel (a futó konténer közben fut)"
remote verify "$DEPLOY_DIR" "$TAG"
step "váltás: media-server:${cur:-(nincs)} → $IMAGE"
remote switch "$DEPLOY_DIR" "$TAG" "$old_compose_inode"
step "régi image-ek takarítása (marad: a mostani, az előző és a legújabb $KEEP)"
remote prune "$DEPLOY_DIR" "$KEEP" || echo "deploy: FIGYELEM: a takarítás nem sikerült (a deploy rendben)" >&2
step "kész: $WHERE fut: $IMAGE (előző: ${cur:-nincs})"
