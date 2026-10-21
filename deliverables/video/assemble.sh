#!/usr/bin/env bash
# Assemble deliverables/video/demo-v1.mp4 from deliverables/takes/*.webm.
# ffmpeg/ffprobe only, no network. Re-runnable: uses whatever takes exist now.
# Silent video, captions burned in from demo-v1.srt (the .srt also ships as a side-car).
# Each shot = take slowed by at most 2x, then last frame held, to the shot length (SHOTS table): the
# spoken line plus about 2 s, measured on the voice-over recording.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAKES="$HERE/../takes"
OUT="$HERE/demo-v1.mp4"
SRT="$HERE/demo-v1.srt"
FONT="${FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf}"
FONTB="${FONTB:-/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf}"
W=1440; H=900; FPS=25

# id|take file (or "card")|shot length in seconds|card title|card line 2|card line 3
SHOTS=(
"S1|card|13|Interop Playground|Run real Inji issuers, wallets and verifiers against each other.|"
"S2|s02-environment.webm|12"
"S3|s03-select.webm|12.5"
"S4|s04-issuance.webm|19"
"S5|s05-decoded.webm|13"
"S6|s06-present.webm|15"
"S7|s07-report.webm|10.5"
"S9|s09-labels.webm|12.5"
"S10|s10-fixit.webm|33"
"S11|card|13|Interop report and gaps|docs/interop-report.md: every combination we ran and its outcome|docs/gaps.md: Inji defects with reproduction steps"
"S12|card|10|Interop Playground|Repository: https://github.com/abhijay-jindal-604/interop-playground|Team Bhrinjal (Abhijay Jindal)"
)

for t in ffmpeg ffprobe; do command -v "$t" >/dev/null || { echo "missing $t" >&2; exit 1; }; done
[ -f "$SRT" ] || { echo "missing $SRT" >&2; exit 1; }
[ -f "$FONT" ] && [ -f "$FONTB" ] || { echo "missing font (set FONT / FONTB)" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
LIST="$TMP/list.txt"; : > "$LIST"
ENC=(-c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -r "$FPS" -an)

for row in "${SHOTS[@]}"; do
  IFS='|' read -r id take dur l1 l2 l3 <<<"$row"
  seg="$TMP/$id.mp4"
  if [ "$take" = card ]; then
    printf '%s' "$l1" > "$TMP/$id.1"; printf '%s' "$l2" > "$TMP/$id.2"; printf '%s' "$l3" > "$TMP/$id.3"
    vf="drawtext=fontfile=$FONTB:textfile=$TMP/$id.1:fontcolor=white:fontsize=72:x=(w-text_w)/2:y=300"
    vf+=",drawtext=fontfile=$FONT:textfile=$TMP/$id.2:fontcolor=0xcfd8dc:fontsize=34:x=(w-text_w)/2:y=440"
    [ -n "$l3" ] && vf+=",drawtext=fontfile=$FONT:textfile=$TMP/$id.3:fontcolor=0xcfd8dc:fontsize=34:x=(w-text_w)/2:y=500"
    ffmpeg -v error -y -f lavfi -i "color=c=0x14181f:s=${W}x${H}:r=$FPS:d=$dur" -vf "$vf" "${ENC[@]}" "$seg"
  else
    src="$TAKES/$take"
    [ -f "$src" ] || { echo "missing take $src" >&2; exit 1; }
    d="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src")"
    f="$(awk -v t="$dur" -v d="$d" 'BEGIN{f=t/d; if(f>2)f=2; if(f<1)f=1; printf "%.4f",f}')"
    ffmpeg -v error -y -i "$src" \
      -vf "fps=$FPS,scale=$W:$H,setpts=PTS*$f,tpad=stop_mode=clone:stop_duration=$dur" \
      -t "$dur" "${ENC[@]}" "$seg"
  fi
  echo "file '$seg'" >> "$LIST"
  echo "$id: ${take} -> ${dur}s"
done

cp "$SRT" "$TMP/sub.srt"
(cd "$TMP" && ffmpeg -v error -y -f concat -safe 0 -i list.txt \
  -vf "subtitles=sub.srt:force_style='FontName=DejaVu Sans,FontSize=9,Bold=1,BorderStyle=3,Outline=2,Shadow=0,MarginV=10'" \
  -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -movflags +faststart -an "$OUT")

# Checks: duration <= 300 s, size <= 50 MB, srt last cue ends within the video.
dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")"
res="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$OUT")"
cues="$(grep -c -- '-->' "$SRT")"
last="$(grep -- '-->' "$SRT" | tail -1 | awk '{split($3,a,/[:,]/); print a[1]*3600+a[2]*60+a[3]+a[4]/1000}')"
size="$(stat -c %s "$OUT")"
echo "demo-v1.mp4: ${dur}s, ${res}, ${size} bytes, ${cues} cues, last cue ends ${last}s"
awk -v d="$dur" -v l="$last" -v s="$size" 'BEGIN{exit !(d<=300 && l<=d && s<=50*1024*1024)}' \
  || { echo "limit check failed (<=300 s, last cue <= video, <=50 MB)" >&2; exit 1; }
