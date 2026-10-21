#!/usr/bin/env bash
# Assemble deliverables/video/demo-v1.mp4 from deliverables/takes/*.webm.
# ffmpeg/ffprobe only, no network. Re-runnable: uses whatever takes exist now.
# Silent video, captions burned in from demo-v1.srt (the .srt also ships as a side-car).
# Each shot = take slowed by at most 2x, then last frame held, to the shot length (SHOTS table): the
# spoken line plus a 0.35 s lead and 0.55 s tail, measured on the voice-over recording. The takes are
# recorded to these lengths, so they play at 1x. Title cards and captions use the product's "Document"
# look: paper and ink, Source Serif 4 titles, IBM Plex Sans lines (fonts/, SIL OFL 1.1).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAKES="$HERE/../takes"
OUT="$HERE/demo-v1.mp4"
SRT="$HERE/demo-v1.srt"
FONTS="$HERE/fonts"
FONT="${FONT:-$FONTS/IBMPlexSans-Regular.ttf}"
FONTB="${FONTB:-$FONTS/SourceSerif4-SemiBold.ttf}"
PAPER=0xf7f5f0; INK=0x1a1c1b; MUTED=0x5a5852; RULE=0xd9d5cc
CAPTION_STYLE="FontName=IBM Plex Sans Medium,FontSize=9,Bold=0,BorderStyle=3,Outline=2,Shadow=0,MarginV=10,PrimaryColour=&H00F0F5F7,OutlineColour=&H001B1C1A,BackColour=&H001B1C1A"
W=1440; H=900; FPS=25

# id|take file (or "card")|shot length in seconds|card title|card line 2|card line 3
SHOTS=(
"S1|card|10.7|Interop Playground|Run real Inji issuers, wallets and verifiers against each other.|"
"S2|s02-environment.webm|10.7"
"S3|s03-select.webm|11"
"S4|s04-issuance.webm|15.6"
"S5|s05-decoded.webm|12"
"S6|s06-present.webm|11.6"
"S7|s07-report.webm|9.2"
"S9|s09-labels.webm|8.6"
"S10|s10-fixit.webm|27.3"
"S11|card|11.4|Interop report and gaps|docs/interop-report.md: every combination we ran and its outcome|docs/gaps.md: Inji defects with reproduction steps"
"S12|card|8|Interop Playground|Repository: https://github.com/abhijay-jindal-604/interop-playground|Team Bhrinjal (Abhijay Jindal)"
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
    vf="drawtext=fontfile=$FONTB:textfile=$TMP/$id.1:fontcolor=$INK:fontsize=76:x=(w-text_w)/2:y=290"
    vf+=",drawbox=x=(iw-120)/2:y=408:w=120:h=2:color=$RULE:t=fill"
    vf+=",drawtext=fontfile=$FONT:textfile=$TMP/$id.2:fontcolor=$MUTED:fontsize=32:x=(w-text_w)/2:y=450"
    [ -n "$l3" ] && vf+=",drawtext=fontfile=$FONT:textfile=$TMP/$id.3:fontcolor=$MUTED:fontsize=32:x=(w-text_w)/2:y=505"
    ffmpeg -v error -y -f lavfi -i "color=c=$PAPER:s=${W}x${H}:r=$FPS:d=$dur" -vf "$vf" "${ENC[@]}" "$seg"
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
  -vf "subtitles=sub.srt:fontsdir=$FONTS:force_style='$CAPTION_STYLE'" \
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
