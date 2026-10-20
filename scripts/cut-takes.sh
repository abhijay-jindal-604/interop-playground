#!/usr/bin/env bash
# Splits a multi-shot take into one file per shot (plan/13 §2.2), using the `<take>.marks.json`
# cut points written by the live take specs (e2e/live/takes.live.spec.ts):
#   scripts/cut-takes.sh deliverables/takes/s03-s07-slice.webm
# writes deliverables/takes/<mark>.webm for every mark but the last ("end"). Needs ffmpeg + node.
set -euo pipefail
take="${1:?usage: scripts/cut-takes.sh <take.webm>}"
marks="${take}.marks.json"
[[ -f "$take" && -f "$marks" ]] || { echo "missing $take or $marks" >&2; exit 1; }
dir="$(dirname "$take")"
node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (let i = 0; i + 1 < m.length; i++) console.log(m[i][0], m[i][1], m[i + 1][1]);
' "$marks" | while read -r name from to; do
  out="${dir}/${name}.webm"
  ffmpeg -nostdin -v error -y -ss "$from" -to "$to" -i "$take" -c:v libvpx -b:v 2M -an "$out"
  printf '%s %ss\n' "$out" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out")"
done
