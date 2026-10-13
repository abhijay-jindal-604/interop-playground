#!/usr/bin/env bash
# Stop and remove every container of the bundle, all profiles (plan/10 §8.1). Never removes
# volumes: there is no -v here, by design (history, Inji state). Use scripts/up.sh --reset or
# --reset-history to wipe state deliberately.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

args=(compose -p interop-playground)
for f in .env .env.local; do
  [[ -f "$f" ]] && args+=(--env-file "$f")
done
# compose interpolates ${PUBLIC_HOST:?} even for `down`; any value works when .env is absent
export PUBLIC_HOST="${PUBLIC_HOST:-$(sed -n 's/^PUBLIC_HOST=//p' .env 2>/dev/null | tail -1)}"
export PUBLIC_HOST="${PUBLIC_HOST:-127.0.0.1}"
export ESIGNET_KEYSTORE_PASSWORD="${ESIGNET_KEYSTORE_PASSWORD:-unused-for-down}"
docker "${args[@]}" --profile '*' down --remove-orphans
