#!/usr/bin/env bash
# A médiaszerver telepítése a szerverre (terv 7.3; implementációs terv WP4).
#
#   server/deploy/deploy.sh [--dry-run]                     (gyökérből: pnpm server:deploy [--dry-run])
#
# 1. Előfeltételek: helyben rsync + ssh és a forrásfájlok; a szerveren a DEPLOY_DIR létezik és írható, megvan a
#    .env és a secrets/apps.json, a .env MEDIA_ROOT / APPS_JSON útvonala létezik, a docker compose elérhető.
# 2. rsync: CSAK a compose.yaml, az nginx/ és az njs/ (a --delete csak ezen a két könyvtáron belül hat). A .env,
#    a secrets/ és a data/ a szerveren marad; a szkript ezekbe soha nem ír és nem töröl.
# 3. A szerveren: docker compose config -q; check-apps.js és nginx -t egy eldobható konténerben (`run --rm`,
#    tehát pontosan az új fájlokkal és a mostani apps.json-nal); docker compose up -d --wait; ha a konténer nem
#    jött most létre, de a compose.yaml vagy az apps.json inode-ja változott → restart (az egy fájlként csatolt
#    apps.json új inode-ját a futó konténer nem látja), különben nginx -s reload (-c-vel); végül /healthz.
#
# --dry-run: az előfeltételek ellenőrzése és az rsync --dry-run listája; a szerveren semmi nem változik.
# Környezet: DEPLOY_HOST (media-host), DEPLOY_USER (deploy), DEPLOY_DIR (/srv/media-server), DEPLOY_SSH_OPTS.
# Sudo nincs benne; az egyszeri sudo-lépések a README-ben.

set -euo pipefail

DEPLOY_HOST=${DEPLOY_HOST:-media-host}
DEPLOY_USER=${DEPLOY_USER:-deploy}
DEPLOY_DIR=${DEPLOY_DIR:-/srv/media-server}
DEPLOY_SSH_OPTS=${DEPLOY_SSH_OPTS:-"-o BatchMode=yes -o ConnectTimeout=10"}

DRY_RUN=0
usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run | -n) DRY_RUN=1 ;;
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

die() {
  echo "deploy: HIBA: $*" >&2
  exit 1
}
step() { echo "==> $*"; }

APP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"
read -r -a SSH_OPTS <<<"$DEPLOY_SSH_OPTS"

[[ "$DEPLOY_DIR" == /* && "$DEPLOY_DIR" != / ]] || die "a DEPLOY_DIR abszolút útvonal legyen, és ne a / ($DEPLOY_DIR)"
[[ "$DEPLOY_DIR" != *[[:space:]]* ]] || die "a DEPLOY_DIR nem tartalmazhat szóközt ($DEPLOY_DIR)"

# --- 1. helyi előfeltételek -------------------------------------------------------------------------------------
for cmd in rsync ssh; do
  command -v "$cmd" >/dev/null 2>&1 || die "a(z) '$cmd' nincs telepítve a fejlesztőgépen"
done
for f in compose.yaml nginx/nginx.conf nginx/media.conf nginx/templates/realip.conf.template njs/media.js \
  njs/check-apps.js; do
  [[ -f "$APP_DIR/$f" ]] || die "hiányzik a forrásfájl: $APP_DIR/$f"
done

ssh_run() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

# A távoli szkript (bash -s) első argumentuma a fázis, a második a DEPLOY_DIR, a többi fázisfüggő.
remote() {
  local args
  args=$(printf '%q ' "$@")
  ssh_run "bash -s -- $args" <<'REMOTE'
set -euo pipefail
phase=$1
dir=$2
shift 2
die() { echo "deploy (szerver): HIBA: $*" >&2; exit 1; }
inode() { if [[ -e "$1" ]]; then stat -c %i "$1"; else echo none; fi; }
# A .env egy változójának (utolsó) értéke, idézőjelek nélkül; relatív útvonal a DEPLOY_DIR-hez képest.
env_path() {
  local v
  v=$(sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$dir/.env" | tail -n 1)
  v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
  [[ -n "$v" ]] || die "a .env-ben nincs $1"
  [[ "$v" == /* ]] || v="$dir/${v#./}"
  printf '%s\n' "$v"
}

case "$phase" in
  check)
    [[ -d "$dir" ]] || die "$dir nem létezik – egyszeri sudo-lépés: sudo install -d -o $(id -un) -g docker $dir (README)"
    [[ -w "$dir" ]] || die "$dir nem írható a(z) $(id -un) felhasználónak (tulajdonos: $(stat -c %U:%G "$dir"))"
    [[ -f "$dir/.env" ]] || die "$dir/.env hiányzik – kézzel kell létrehozni (README: .env a szerveren)"
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
    # A compose.yaml mostani inode-ja (az rsync átnevezéssel ír: változáskor új inode).
    echo "compose-inode=$(inode "$dir/compose.yaml")"
    ;;

  apply)
    old_compose_inode=$1
    cd "$dir"
    nginx_c=(nginx -c /etc/nginx/media/nginx.conf)
    echo "--> docker compose config -q"
    docker compose config -q
    echo "--> check-apps.js (eldobható konténerben)"
    docker compose run --rm --no-deps -T -e NGINX_ENTRYPOINT_QUIET_LOGS=1 media njs -q -m -p /etc/nginx/njs /etc/nginx/njs/check-apps.js
    echo "--> nginx -t (eldobható konténerben)"
    docker compose run --rm --no-deps -T -e NGINX_ENTRYPOINT_QUIET_LOGS=1 media "${nginx_c[@]}" -t
    before=$(docker compose ps -q media 2>/dev/null || true)
    echo "--> docker compose up -d --wait"
    docker compose up -d --wait
    after=$(docker compose ps -q media)
    if [[ -z "$before" || "$before" != "$after" ]]; then
      echo "--> a konténer most jött létre: nincs szükség újratöltésre"
    else
      apps=$(env_path APPS_JSON)
      host_apps_inode=$(inode "$apps")
      ctr_apps_inode=$(docker compose exec -T media stat -c %i /etc/nginx/secrets/apps.json)
      new_compose_inode=$(inode "$dir/compose.yaml")
      if [[ "$new_compose_inode" != "$old_compose_inode" || "$host_apps_inode" != "$ctr_apps_inode" ]]; then
        echo "--> a compose.yaml vagy az apps.json inode-ja változott: docker compose restart media"
        docker compose restart media
      else
        echo "--> nginx -s reload"
        docker compose exec -T media "${nginx_c[@]}" -s reload
      fi
    fi
    hp=$(docker compose port media 80)
    [[ -n "$hp" ]] || die "a media szolgáltatás 80-as portja nincs kiadva"
    echo "--> /healthz ($hp)"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      code=$(curl -sS -o /dev/null -w '%{http_code}' "http://$hp/healthz" || true)
      [[ "$code" == 204 ]] && break
      sleep 1
    done
    [[ "$code" == 204 ]] || die "a /healthz válasza $code (várt: 204) – napló: docker compose logs --tail 50 media"
    echo "--> /healthz 204"
    docker compose ps media
    ;;

  *) die "ismeretlen fázis: $phase" ;;
esac
REMOTE
}

# --- 2. a szerver előfeltételei ---------------------------------------------------------------------------------
step "a szerver ellenőrzése: $TARGET:$DEPLOY_DIR"
ssh_err=$(ssh_run true 2>&1) ||
  die "nem érem el ssh-n: $TARGET (DEPLOY_HOST / DEPLOY_USER, kulcsos belépés?): ${ssh_err:-ismeretlen hiba}"
check_out=$(remote check "$DEPLOY_DIR") || exit 1
old_compose_inode=$(sed -n 's/^compose-inode=//p' <<<"$check_out")
[[ -n "$old_compose_inode" ]] || die "a szerver ellenőrzése nem adott compose-inode-ot: $check_out"

# --- 3. rsync (csak a kezelt fájlok) ----------------------------------------------------------------------------
# --checksum: csak a tartalmában változott fájl íródik újra (így az inode csak valódi változásnál cserélődik);
# -rt + --chmod: a konténer nginx-felhasználója olvashassa; tulajdonos / csoport a szerveré marad.
RSYNC=(rsync -rt --checksum --chmod=D755,F644 --itemize-changes -e "ssh ${DEPLOY_SSH_OPTS}")
mode_note=""
if ((DRY_RUN)); then
  RSYNC+=(--dry-run)
  mode_note=" (dry-run)"
fi

step "rsync${mode_note}: compose.yaml, nginx/, njs/"
"${RSYNC[@]}" "$APP_DIR/compose.yaml" "$TARGET:$DEPLOY_DIR/compose.yaml"
for d in nginx njs; do
  # A --delete csak a $DEPLOY_DIR/$d/ alatt hat (a cél maga ez a könyvtár).
  "${RSYNC[@]}" --delete "$APP_DIR/$d/" "$TARGET:$DEPLOY_DIR/$d/"
done

if ((DRY_RUN)); then
  step "dry-run: a szerveren nem fut semmi. Élesben ezután:"
  cat <<EOF
    cd $DEPLOY_DIR
    docker compose config -q
    docker compose run --rm --no-deps -T -e NGINX_ENTRYPOINT_QUIET_LOGS=1 media njs -q -m -p /etc/nginx/njs /etc/nginx/njs/check-apps.js
    docker compose run --rm --no-deps -T -e NGINX_ENTRYPOINT_QUIET_LOGS=1 media nginx -c /etc/nginx/media/nginx.conf -t
    docker compose up -d --wait
    # ha a konténer nem most jött létre: restart (compose.yaml / apps.json inode változott) vagy
    docker compose exec -T media nginx -c /etc/nginx/media/nginx.conf -s reload
    curl http://<docker compose port media 80>/healthz   # 204
EOF
  exit 0
fi

# --- 4. a szerveren: ellenőrzés, indítás / újratöltés, /healthz --------------------------------------------------
step "a szerveren: config, check-apps, nginx -t, up, reload / restart, healthz"
remote apply "$DEPLOY_DIR" "$old_compose_inode"
step "kész: $TARGET:$DEPLOY_DIR"
