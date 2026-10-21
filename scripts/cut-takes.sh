#!/usr/bin/env bash
# Cuts the video takes written by the live take specs (e2e/live/*.live.spec.ts):
#   scripts/cut-takes.sh deliverables/takes/s03-s07-slice.webm
# With `<take>.marks.json` (written by takes.live.spec.ts) it writes deliverables/takes/<mark>.webm
# for every mark but the last ("end"). Each mark flashed a magenta strip across the top of the page
# (e2e/live/take.ts): the cuts are found from those strips in the video (the page video drops frames
# under load, so the wall-clock seconds in the marks file drift) and leave the strip frames out.
# Without marks the take is trimmed in place: the blank (all-white) frames at its start are cut
# (the page video runs from the page's creation, before the first page has painted).
# Needs ffmpeg + node.
set -euo pipefail
take="${1:?usage: scripts/cut-takes.sh <take.webm>}"
[[ -f "$take" ]] || { echo "missing $take" >&2; exit 1; }
marks="${take}.marks.json"
dir="$(dirname "$take")"

cut() { # cut <out> <from> [<to>]
  local to=()
  [[ -n "${3:-}" ]] && to=(-to "$3")
  ffmpeg -nostdin -v error -y -ss "$2" "${to[@]}" -i "$take" -c:v libvpx -b:v 2M -an "$1"
  printf '%s %ss\n' "$1" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$1")"
}

# per frame: "<seconds> <YMIN> <UMIN> <VMIN>" of the given crop of the frame
stats() {
  ffmpeg -nostdin -v error -i "$take" -vf "$1,signalstats,metadata=print:file=-" -an -f null - |
    awk '/^frame:/{split($3,a,":"); t=a[2]} /YMIN=/{split($0,b,"=");y=b[2]} /UMIN=/{split($0,b,"=");u=b[2]}
         /VMIN=/{split($0,b,"="); print t, y, u, b[2]}'
}

if [[ -f "$marks" ]]; then
  # strips: runs of frames whose top rows are all magenta (high U and V); one strip per mark
  stats "crop=iw:4:0:2" | node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const frames = fs.readFileSync(0, "utf8").trim().split("\n").map((l) => l.split(" ").map(Number));
    const strips = [];
    let open = null, prev = 0;
    for (const [pts, , u, v] of frames) {
      const t = pts, on = u > 170 && v > 170;
      if (on && !open) open = [t, t];
      if (on) open[1] = t;
      if (!on && open) { strips.push([open[0], t]); open = null; }
      prev = t;
    }
    if (open) strips.push([open[0], prev]);
    if (strips.length !== m.length) {
      console.error(`found ${strips.length} mark strips in the video, the marks file has ${m.length}`);
      process.exit(1);
    }
    for (let i = 0; i + 1 < m.length; i++) console.log(m[i][0], strips[i][1].toFixed(3), strips[i + 1][0].toFixed(3));
  ' "$marks" > "${take}.cuts"
  while read -r name from to; do cut "${dir}/${name}.webm" "$from" "$to"; done < "${take}.cuts"
  rm -f "${take}.cuts"
else
  # first frame with any non-white pixel (luma min below 200)
  first="$(stats "null" | awk '$2 < 200 {print $1; exit}')"
  tmp="${take%.webm}.trim.webm"
  cut "$tmp" "${first:-0}"
  mv -f "$tmp" "$take"
fi
