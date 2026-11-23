#!/usr/bin/env bash
# Szintetikus próbamédia a médiaszerver élő elfogadásához (implementációs terv WP4, terv 8. MS1).
#
#   server/scripts/make-test-video.sh <kimeneti gyökér> [perc]      (alap: 44 perc)
#
# A <kimeneti gyökér> a szerver data/ könyvtárának megfelelője (MEDIA_ROOT); utána pl.
#   rsync -rt --chmod=D755,F644 <gyökér>/ media-host:/srv/media-server/data/
# CSAK szintetikus média (testsrc2 + szinusz); valódi tartalom nem része ennek a repónak.
#
# Kimenet (kulcsalakú útvonalak):
#   elearning/proba-tema/lessons/ch-01-l01/m01.720p.mp4    <perc> perces 1280x720 H.264/AAC, ~1,5 Mbit/s, +faststart
#   elearning/proba-tema/lessons/ch-01-l01/m01.audio.m4a   30 s AAC
#   elearning/proba-tema/lessons/ch-01-l01/m01.poster.jpg  1280x720 JPG
#   elearning/proba-tema/lessons/ch-01-l01/m01.720p.mp4.build.json   (a 404-próbához)
#   elearning/_content/2026.11.23-proba.json.gz            szintetikus "kiadás" (nem valódi)
#   proba/proba-tema/lessons/ch-01-l01/m01.720p.mp4        a második app próbafájlja (10 s)
# Meglévő fájlt nem generál újra (a 44 perces MP4 kódolása perceket vesz igénybe); --force: mindent újra.

set -euo pipefail

force=0
args=()
for a in "$@"; do
  case "$a" in
    --force) force=1 ;;
    -h | --help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) args+=("$a") ;;
  esac
done
[[ ${#args[@]} -ge 1 ]] || {
  echo "Használat: make-test-video.sh <kimeneti gyökér> [perc] [--force]" >&2
  exit 2
}
root=${args[0]}
minutes=${args[1]:-44}
[[ "$minutes" =~ ^[0-9]+$ && "$minutes" -ge 1 ]] || {
  echo "make-test-video: a perc pozitív egész legyen ($minutes)" >&2
  exit 2
}
command -v ffmpeg >/dev/null 2>&1 || {
  echo "make-test-video: nincs ffmpeg" >&2
  exit 1
}

ff() { ffmpeg -hide_banner -loglevel error -nostdin -y "$@"; }
need() { ((force)) || [[ ! -s "$1" ]]; }

lesson="$root/elearning/proba-tema/lessons/ch-01-l01"
mkdir -p "$lesson" "$root/elearning/_content" "$root/proba/proba-tema/lessons/ch-01-l01"

secs=$((minutes * 60))
video="$lesson/m01.720p.mp4"
if need "$video"; then
  echo "==> $video ($minutes perc, 720p, ~1,5 Mbit/s – eltart egy ideig)"
  ff -f lavfi -i "testsrc2=size=1280x720:rate=25:duration=$secs" \
    -f lavfi -i "sine=frequency=440:beep_factor=4:sample_rate=48000:duration=$secs" \
    -c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p \
    -b:v 1400k -maxrate 1800k -bufsize 3600k -g 50 \
    -c:a aac -b:a 96k -ac 2 -shortest -movflags +faststart "$video.part.mp4"
  mv -f "$video.part.mp4" "$video"
fi

audio="$lesson/m01.audio.m4a"
need "$audio" && ff -f lavfi -i "sine=frequency=330:sample_rate=48000:duration=30" -c:a aac -b:a 96k "$audio"
poster="$lesson/m01.poster.jpg"
need "$poster" && ff -f lavfi -i "testsrc2=size=1280x720" -frames:v 1 -q:v 3 "$poster"
printf '{"synthetic":true}\n' >"$video.build.json"

content="$root/elearning/_content/2026.11.23-proba.json.gz"
printf '{"synthetic":true,"version":"2026.11.23-proba","note":"proba-kiadas, nem valodi tartalom"}\n' |
  gzip -n -9 >"$content"

other="$root/proba/proba-tema/lessons/ch-01-l01/m01.720p.mp4"
need "$other" && ff -f lavfi -i "testsrc2=size=640x360:rate=25:duration=10" \
  -f lavfi -i "sine=frequency=550:duration=10" \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart "$other"

echo "==> kész: $root"
find "$root" -type f -printf '%10s  %P\n' | sort -k2
