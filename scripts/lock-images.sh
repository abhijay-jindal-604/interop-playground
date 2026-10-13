#!/usr/bin/env bash
# Developer action (plan/10 §2.6, RISK-19): re-resolve every tag in versions.lock to its current
# registry digest, show the diff and rewrite the file after confirmation. Never run by up.sh
# (up.sh --update-lock calls it explicitly). Entries whose key carries a `#<name>` suffix are
# frozen digests of a moving tag (e.g. the S-206 IAE image) and are never re-resolved.
#   scripts/lock-images.sh [--yes]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

yes=0
[[ "${1:-}" == "--yes" ]] && yes=1
lock=versions.lock
new="$(mktemp)"
trap 'rm -f -- "$new"' EXIT

today="$(date -u +%F)"
{
  printf '{\n  "checkedAt": "%s",\n  "images": {\n' "$today"
  first=1
  while IFS= read -r line; do
    key="$(sed -n 's/^ *"\([^"]*\)": "\(sha256:[0-9a-f]*\)",\{0,1\}$/\1/p' <<<"$line")"
    old="$(sed -n 's/^ *"\([^"]*\)": "\(sha256:[0-9a-f]*\)",\{0,1\}$/\2/p' <<<"$line")"
    [[ -n "$key" ]] || continue
    digest="$old"
    if [[ "$key" != *"#"* ]]; then
      if ! digest="$(docker buildx imagetools inspect "$key" | sed -n 's/^Digest: *//p' | head -1)" || [[ -z "$digest" ]]; then
        echo "lock-images: cannot resolve $key" >&2
        exit 1
      fi
    fi
    [[ $first -eq 1 ]] || printf ',\n'
    first=0
    printf '    "%s": "%s"' "$key" "$digest"
  done < "$lock"
  printf '\n  }\n}\n'
} > "$new"

if diff -u "$lock" "$new"; then
  echo "lock-images: no digest changed"
  exit 0
fi
if [[ $yes -ne 1 ]]; then
  read -r -p "Write these digests to $lock? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "lock-images: unchanged"; exit 1; }
fi
cp "$new" "$lock"
echo "lock-images: $lock updated; review and commit it"
