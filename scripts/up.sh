#!/usr/bin/env bash
# One-command bring-up of the interop-playground bundle (plan/10 §8.1, ADR-14, ADR-17, ADR-45).
#
#   scripts/up.sh [--mode local|collab] [--with peers] [--with mdoc-spec] [--with iae] [--with debug]
#                 [--rotate-ca] [--reset] [--reset-history] [--update-lock] [--no-build]
#
# Idempotent: a second run on a healthy bundle changes nothing and recreates no container.
# Needs only bash, docker (+ compose plugin), openssl, ss and curl. Never passes -v to compose.
#
# BFF CLI (T-07, ADR-54, ADR-60):
#  - config is rendered by docker/render-config.sh (`playground render-config` in the bff image
#    implements the same rules and is tested byte-for-byte against it);
#  - the chain steps esignet-onboard, certify-didurl and guest-smoke run in a throw-away bff
#    container (`docker compose run --rm --no-deps bff playground ...`) when the bff image
#    exists; without it they are reported as skipped. The Mimoto p12 is always built here with
#    openssl around the existing client key, never a new key (S-105, S-150, ADR-60);
#  - readiness: internal service names via `docker compose exec`, then `playground wait-ready`,
#    then the bff probe GET http://127.0.0.1:3100/api/v1/health from the host, then the
#    gateway-URL probes (T-11) from the host with the playground CA.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PROJECT=interop-playground
GATEWAY_PORTS=(443 8093 8096 8097 8098 8099 3004 3005 8095 8443 18103 18443 18444 18445)
BFF_IMAGE=interop-playground/bff:local
NODE_REF="node:22-bookworm-slim"
JRE_REF="eclipse-temurin:21-jre-jammy"
INVARIANT_VOLUMES=(esignet-pg esignet-keys mock-identity-keys certify-authcode-pg certify-preauth-keys certify-preauth-pg)
IAE_VOLUMES=(certify-iae-pg certify-iae-keys)
MARKER=.generated/state/chain.done
STAMP_VOLUME="${PROJECT}_state-stamp" # G-166: who built the shared Inji state (scripts/lib/state-check.sh)
STAMP_LABEL=io.interop-playground.state
# shellcheck source=lib/state-check.sh
source "$ROOT/scripts/lib/state-check.sh"

log() { printf '[up] %s\n' "$*"; }
warn() { printf '[up] WARNING: %s\n' "$*" >&2; }
die() { printf '[up] ERROR: %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ flags --
mode=local
withs=()
rotate_ca=0 reset=0 reset_history=0 update_lock=0 no_build=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) mode="${2:?--mode needs local|collab}"; shift 2 ;;
    --mode=*) mode="${1#--mode=}"; shift ;;
    --with) withs+=("${2:?--with needs a profile}"); shift 2 ;;
    --with=*) withs+=("${1#--with=}"); shift ;;
    --rotate-ca) rotate_ca=1; shift ;;
    --reset) reset=1; shift ;;
    --reset-history) reset_history=1; shift ;;
    --update-lock) update_lock=1; shift ;;
    --no-build) no_build=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown flag $1 (see --help)" ;;
  esac
done
[[ "$mode" == local || "$mode" == collab ]] || die "--mode must be local or collab"
for w in "${withs[@]}"; do
  case "$w" in peers|mdoc-spec|iae|debug) ;; *) die "--with $w: expected peers, mdoc-spec, iae or debug" ;; esac
done
profiles=()
[[ "$mode" == local ]] && profiles+=(local)
profiles+=("${withs[@]}")
COMPOSE_PROFILES="$(IFS=,; echo "${profiles[*]}")"
export COMPOSE_PROFILES

# ----------------------------------------------------------------- helpers --
set_env() { # <file> <key> <value>: replace or append KEY=VALUE
  local file="$1" key="$2" val="$3"
  touch "$file"
  if grep -q "^${key}=" "$file"; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$file" > "$tmp"
    cat "$tmp" > "$file"; rm -f -- "$tmp"
  else
    printf '%s=%s\n' "$key" "$val" >> "$file"
  fi
}
get_env() { sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -1; }
dc() { docker compose -p "$PROJECT" --env-file .env --env-file .env.local "$@"; }
lock_digest() { # <key> -> digest from versions.lock
  sed -n "s/^ *\"$(sed 's/[.[\*^$/]/\\&/g' <<<"$1")\": \"\(sha256:[0-9a-f]\{64\}\)\",\{0,1\}$/\1/p" versions.lock | head -1
}
image_present() { docker image inspect "$1" >/dev/null 2>&1; }
vol_exists() { docker volume inspect "${PROJECT}_$1" >/dev/null 2>&1; }
read_stamp() { docker volume inspect -f "{{index .Labels \"$STAMP_LABEL\"}}" "$STAMP_VOLUME" 2>/dev/null || true; }
write_stamp() { # <marker line>
  docker volume rm "$STAMP_VOLUME" >/dev/null 2>&1 || true
  docker volume create --label "$STAMP_LABEL=$(state_stamp_of "$1")" "$STAMP_VOLUME" >/dev/null
}
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# --------------------------------------------------------------- preflight --
log "preflight"
command -v docker >/dev/null || die "docker not found"
docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon (permission? try: newgrp docker)"
docker compose version >/dev/null 2>&1 || die "docker compose plugin not found"
command -v openssl >/dev/null || die "openssl not found"
command -v ss >/dev/null || die "ss (iproute2) not found"
command -v curl >/dev/null || die "curl not found (the bff probe uses it)"
log "docker $(docker version --format '{{.Server.Version}}'), $(docker compose version --short 2>/dev/null || true), $(openssl version | cut -d' ' -f1-2)"
if docker info --format '{{.SecurityOptions}}' | grep -q rootless; then
  start="$(sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null || echo 1024)"
  [[ "$start" -le 443 ]] || die "rootless Docker cannot bind 443. Fix: sudo sysctl -w net.ipv4.ip_unprivileged_port_start=443"
fi
avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
if [[ "$avail_kb" -lt $((12 * 1024 * 1024)) ]]; then
  warn "only $((avail_kb / 1024)) MiB of memory available; the full bundle wants about 4.5 GiB and 12 GiB free is recommended (S-027)"
fi

[[ -f .env ]] || { cp .env.example .env; log "created .env from .env.example"; }
PUBLIC_HOST="$(get_env .env PUBLIC_HOST)"
if [[ -z "$PUBLIC_HOST" ]]; then
  # main-table default route (a VPN such as WARP may own `ip route get`, S-023)
  PUBLIC_HOST="$(ip -4 route show default 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
  if [[ -z "$PUBLIC_HOST" ]]; then
    dev="$(ip -4 route show default 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)"
    [[ -n "$dev" ]] && PUBLIC_HOST="$(ip -4 addr show dev "$dev" | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p' | head -1)"
  fi
  [[ -n "$PUBLIC_HOST" ]] || die "cannot detect PUBLIC_HOST; set PUBLIC_HOST=<this machine's LAN IPv4> in .env"
  set_env .env PUBLIC_HOST "$PUBLIC_HOST"
  log "PUBLIC_HOST=$PUBLIC_HOST (detected, written to .env)"
fi
[[ "$PUBLIC_HOST" != 127.* ]] || die "PUBLIC_HOST must not be a loopback address (containers must reach it, ADR-06)"
# a DHCP lease change leaves a stale address in .env; docker would fail later binding it (443)
if command -v ip >/dev/null && ! ip -4 -o addr show 2>/dev/null | grep -q " inet ${PUBLIC_HOST//./\\.}/"; then
  die "PUBLIC_HOST=$PUBLIC_HOST (from .env) is not an address of this machine; set PUBLIC_HOST= (empty) in .env to re-detect it"
fi
export PUBLIC_HOST
set_env .env COMPOSE_PROFILES "$COMPOSE_PROFILES"
set_env .env PLAYGROUND_MODE "$mode"

touch .env.local
chmod 0600 .env.local
if [[ -z "$(get_env .env.local ESIGNET_KEYSTORE_PASSWORD)" ]]; then
  set_env .env.local ESIGNET_KEYSTORE_PASSWORD "$(openssl rand 32 | b64url)"
fi

# ports: free unless our own bff container already holds them
bff_running=0
[[ -n "$(dc ps -q --status running bff 2>/dev/null)" ]] && bff_running=1
if [[ $bff_running -eq 0 ]]; then
  listening="$(ss -ltnH 2>/dev/null | awk '{print $4}')"
  for p in 3100 "${GATEWAY_PORTS[@]}"; do
    for addr in "127.0.0.1:$p" "$PUBLIC_HOST:$p" "0.0.0.0:$p" "*:$p" "[::]:$p"; do
      if grep -qxF "$addr" <<<"$listening"; then
        owner="$(ss -ltnpH "sport = :$p" 2>/dev/null | sed -n 's/.*users:((\("[^"]*"\).*/\1/p' | head -1)"
        die "port $p is already bound on $addr by ${owner:-another process}; free it first (443 is reserved for the bundle, 10 §7.3)"
      fi
    done
  done
fi

# ------------------------------------------------------------ lock + pulls --
[[ $update_lock -eq 1 ]] && { bash scripts/lock-images.sh || die "lock not updated"; }
ensure_image() { # <compose image ref> : pull by the locked digest and tag it
  local ref="$1" base="${1%%@*}" digest="" want key
  [[ "$ref" == interop-playground/* ]] && return 0
  if [[ "$ref" == *@sha256:* ]]; then
    want="${ref##*@}"
    grep -q "\"$want\"" versions.lock || die "$ref: digest not in versions.lock"
    image_present "$base@$want" && return 0
    log "pull $base@$want"
    docker pull -q "$base@$want" >/dev/null || die "cannot pull $ref; the digest may be gone from the registry: run scripts/up.sh --update-lock (RISK-19)"
    return 0
  fi
  key="$ref"
  digest="$(lock_digest "$key")"
  [[ -n "$digest" ]] || die "$ref is not pinned in versions.lock (run scripts/lock-images.sh)"
  local repo="${ref%:*}"
  if [[ "$(docker image inspect --format '{{join .RepoDigests " "}}' "$ref" 2>/dev/null)" == *"$repo@$digest"* ]]; then
    return 0
  fi
  if ! image_present "$repo@$digest"; then
    log "pull $repo@$digest ($ref)"
    docker pull -q "$repo@$digest" >/dev/null || die "cannot pull $repo@$digest for $ref; the digest may be gone: run scripts/up.sh --update-lock (RISK-19)"
  fi
  docker tag "$repo@$digest" "$ref"
}
log "images (versions.lock, profiles: ${COMPOSE_PROFILES:-core})"
ensure_image "$NODE_REF"
ensure_image "$JRE_REF"
NODE_IMG="${NODE_REF}"
JRE_IMG="${JRE_REF}"
while IFS= read -r img; do
  [[ -n "$img" ]] && ensure_image "$img"
done < <(dc config --images 2>/dev/null | sort -u)

# ------------------------------------------------------------------ resets --
if [[ $reset_history -eq 1 ]]; then
  read -r -p "This deletes every stored run (volume playground-data). Type 'delete history' to confirm: " answer
  [[ "$answer" == "delete history" ]] || die "history kept"
  dc rm -s -f bff >/dev/null 2>&1 || true
  vol_exists playground-data && docker volume rm "${PROJECT}_playground-data" >/dev/null
  log "history removed"
fi
remove_state() { # wipe the ADR-14 invariant together (10 §7.6)
  log "removing Inji state volumes: ${INVARIANT_VOLUMES[*]} ${IAE_VOLUMES[*]}"
  dc --profile '*' down --remove-orphans >/dev/null 2>&1 || true
  for v in "${INVARIANT_VOLUMES[@]}" "${IAE_VOLUMES[@]}"; do
    vol_exists "$v" && docker volume rm "${PROJECT}_$v" >/dev/null
  done
  docker volume rm "$STAMP_VOLUME" >/dev/null 2>&1 || true
  rm -f -- "$MARKER"
}
[[ $reset -eq 1 ]] && remove_state

# ------------------------------------------------------------------- certs --
log "certs"
umask 077
mkdir -p certs/peers certs/esignet
chmod 0700 certs
if [[ $rotate_ca -eq 1 ]]; then
  log "--rotate-ca: regenerating every file in certs/"
  rm -f -- certs/playground-ca.key certs/playground-ca.pem certs/gateway.key certs/gateway.pem certs/gateway.host \
    certs/bff-admin.token certs/jvm-truststore.p12 certs/peers/waltid-verifier-ed25519.json \
    certs/peers/waltid-issuer.key certs/peers/waltid-issuer.pem
fi
if [[ ! -s certs/playground-ca.key || ! -s certs/playground-ca.pem ]]; then
  openssl ecparam -name prime256v1 -genkey -noout -out certs/playground-ca.key 2>/dev/null
  openssl req -x509 -new -key certs/playground-ca.key -sha256 -days 3650 -out certs/playground-ca.pem \
    -subj "/CN=interop-playground local CA/O=interop-playground" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  rm -f -- certs/gateway.pem certs/jvm-truststore.p12
  log "new playground CA"
fi
CA_FP="$(openssl x509 -in certs/playground-ca.pem -noout -fingerprint -sha256 | cut -d= -f2)"
if [[ ! -s certs/gateway.pem || "$(cat certs/gateway.host 2>/dev/null)" != "$PUBLIC_HOST" ]] \
  || ! openssl verify -CAfile certs/playground-ca.pem certs/gateway.pem >/dev/null 2>&1; then
  openssl ecparam -name prime256v1 -genkey -noout -out certs/gateway.key 2>/dev/null
  openssl req -new -key certs/gateway.key -subj "/CN=${PUBLIC_HOST}" -out certs/gateway.csr 2>/dev/null
  printf 'subjectAltName=IP:%s,DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' "$PUBLIC_HOST" > certs/gateway.ext
  openssl x509 -req -in certs/gateway.csr -CA certs/playground-ca.pem -CAkey certs/playground-ca.key \
    -CAcreateserial -days 825 -sha256 -extfile certs/gateway.ext -out certs/gateway.pem 2>/dev/null
  rm -f -- certs/gateway.csr certs/gateway.ext certs/playground-ca.srl
  printf '%s' "$PUBLIC_HOST" > certs/gateway.host
  log "gateway leaf for IP:$PUBLIC_HOST, DNS:localhost, IP:127.0.0.1"
fi
[[ -s certs/bff-admin.token ]] || openssl rand -hex 32 > certs/bff-admin.token
if [[ ! -s certs/peers/waltid-verifier-ed25519.json ]]; then
  docker run --rm --network none -v "$ROOT/docker/keys:/keys:ro" "$NODE_IMG" node /keys/mk-ed25519-didkey.mjs \
    > certs/peers/waltid-verifier-ed25519.json
  log "walt.id verifier Ed25519 key (S-205)"
fi
if [[ ! -s certs/peers/waltid-issuer.key || ! -s certs/peers/waltid-issuer.pem ]]; then
  openssl ecparam -name prime256v1 -genkey -noout -out certs/peers/waltid-issuer.key 2>/dev/null
  openssl req -x509 -new -key certs/peers/waltid-issuer.key -sha256 -days 3650 -out certs/peers/waltid-issuer.pem \
    -subj "/CN=waltid-issuer.interop-playground/O=interop-playground" 2>/dev/null
fi
if [[ ! -s certs/jvm-truststore.p12 ]]; then
  # JDK cacerts + the playground CA (a CA-only store breaks JSON-LD context fetches, S-185)
  docker run --rm --network none --user "$(id -u):$(id -g)" -v "$ROOT/certs:/certs" "$JRE_IMG" bash -c '
    set -e
    keytool -importkeystore -noprompt -srckeystore "$JAVA_HOME/lib/security/cacerts" -srcstorepass changeit \
      -destkeystore /certs/jvm-truststore.p12 -deststoretype PKCS12 -deststorepass changeit >/dev/null 2>&1
    keytool -importcert -noprompt -alias interop-playground-ca -file /certs/playground-ca.pem \
      -keystore /certs/jvm-truststore.p12 -storetype PKCS12 -storepass changeit >/dev/null'
  log "jvm-truststore.p12 (cacerts + playground CA)"
fi
# Files read inside containers that run as non-root users must be readable by them; the
# directory certs/ (0700) keeps them private on the host. The CA key is never mounted.
chmod 0644 certs/playground-ca.pem certs/gateway.pem certs/gateway.key certs/bff-admin.token certs/jvm-truststore.p12 \
  certs/peers/waltid-verifier-ed25519.json certs/peers/waltid-issuer.key certs/peers/waltid-issuer.pem
chmod 0600 certs/playground-ca.key
chmod 0755 certs/peers certs/esignet
umask 022

# ------------------------------------------------------------------- build --
if [[ $no_build -eq 0 ]]; then
  build=()
  for s in bff sidecar oauth2-mock; do
    dc config --services | grep -qx "$s" && build+=("$s")
  done
  log "build ${build[*]}"
  dc build "${build[@]}" || die "image build failed (use --no-build to start without the locally built images)"
fi

# ------------------------------------------------------------------ render --
log "render config into .generated/config"
mkdir -p .generated/state
WALTID_VERIFIER_DID="$(sed -n 's/.*"did":"\([^"]*\)".*/\1/p' certs/peers/waltid-verifier-ed25519.json)"
WALTID_VERIFIER_KEY_JWK="$(sed -n 's/.*"jwk":\({[^}]*}\).*/\1/p' certs/peers/waltid-verifier-ed25519.json)"
export WALTID_VERIFIER_DID WALTID_VERIFIER_KEY_JWK
rm -rf -- .generated/render.tmp
bash docker/render-config.sh .generated/render.tmp >/dev/null
# sync in place: rewrite a changed file through its existing inode so running bind mounts see it,
# leave unchanged files untouched (no spurious change), drop files that are no longer rendered
mkdir -p .generated/config
( cd .generated/render.tmp && find . -type f ) | while IFS= read -r f; do
  dst=".generated/config/${f#./}"
  mkdir -p "$(dirname "$dst")"
  if [[ ! -f "$dst" ]]; then cp ".generated/render.tmp/${f#./}" "$dst"
  elif ! cmp -s ".generated/render.tmp/${f#./}" "$dst"; then cat ".generated/render.tmp/${f#./}" > "$dst"
  fi
done
( cd .generated/config && find . -type f ) | while IFS= read -r f; do
  [[ -f ".generated/render.tmp/${f#./}" ]] || rm -f -- ".generated/config/${f#./}"
done
rm -rf -- .generated/render.tmp
chmod -R a+rX .generated/config

# --------------------------------------------------------- ADR-14 chain ----
bff_cli=0
image_present "$BFF_IMAGE" && bff_cli=1
run_cli() { dc run --rm --no-deps -T bff playground "$@"; }
# esignet-onboard reads (or creates) the Mimoto client key; only this one-shot run mounts it
run_cli_esignet() { dc run --rm --no-deps -T -v "$ROOT/certs/esignet:/certs/esignet" bff playground "$@"; }
chain_diagnosis() {
  cat >&2 <<'EOF'
[up] The ADR-14 chain failed. Diagnose in this order (plan/01 §3.8 step 9):
  (a) mimoto log shows "BadJwtException: Invalid signature": the p12 does not match the key
      registered at eSignet -> scripts/up.sh --reset
  (b) mimoto log shows "KER-KMA-004": Mimoto was restarted against a different p12 -> scripts/up.sh --reset
  (c) "LOADING_REMOTE_CONTEXT_FAILED" / "PublicKeyResolutionFailedException": stale per-config
      didUrl (G-20) -> scripts/up.sh --reset
  Logs: docker compose -p interop-playground logs mimoto certify-authcode esignet
EOF
}
mimoto_p12() {
  local pw key=certs/esignet/playground-mimoto.key.pem
  pw="$(get_env .env.local ESIGNET_KEYSTORE_PASSWORD)"
  umask 077
  [[ -s "$key" ]] || openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$key" 2>/dev/null
  # self-signed certificate AROUND the existing key, never a new key pair (S-105, S-150)
  openssl req -new -x509 -key "$key" -days 3650 -subj "/CN=playground-mimoto-client" \
    -out certs/esignet/playground-mimoto-selfsigned.crt 2>/dev/null
  openssl pkcs12 -export -in certs/esignet/playground-mimoto-selfsigned.crt -inkey "$key" \
    -name playground-mimoto-client -out certs/esignet/oidckeystore.p12 -passout "pass:$pw"
  umask 022
  chmod 0600 "$key" certs/esignet/oidckeystore.p12
}

onboard_state=n/a
if [[ "$mode" == local ]]; then
  want_marker="public_host=$PUBLIC_HOST ca=$CA_FP"
  have_marker="$(head -1 "$MARKER" 2>/dev/null || true)"
  state_present=1
  for v in "${INVARIANT_VOLUMES[@]}"; do vol_exists "$v" || state_present=0; done
  state_check="$(state_action "$state_present" "$have_marker" "$want_marker" "$(read_stamp)")"
  if [[ "$state_check" == wipe ]]; then
    warn "Inji state was created for another PUBLIC_HOST/CA (or the chain never finished): wiping it (10 §7.6)"
    remove_state
    state_present=0
  elif [[ "$state_check" == other ]]; then
    # G-166: the volumes are shared by every checkout of this compose project; another checkout
    # rebuilt them, so this checkout's Mimoto p12 no longer matches (Mimoto would crash-loop)
    warn "Inji state was built by another checkout on this host (one checkout per host): rebuilding it for this one (same as scripts/up.sh --reset)"
    remove_state
    state_present=0
  elif [[ "$state_check" == adopt ]]; then
    write_stamp "$want_marker"
  fi
  if [[ $state_present -eq 1 && $bff_cli -eq 1 && "$(sed -n 's/^onboard=//p' "$MARKER" 2>/dev/null)" == skipped ]]; then
    # ADR-54 (3): state from a bring-up without the bff CLI has no onboarding; it is wiped and
    # rebuilt together (10 §7.6 invariant), history (playground-data) is never touched
    warn "Inji state was created without eSignet onboarding (onboard=skipped): rebuilding it with the bff CLI"
    remove_state
    state_present=0
  fi
  if [[ $state_present -eq 0 || ! -s certs/esignet/oidckeystore.p12 ]]; then
    log "ADR-14 chain: eSignet up"
    dc up -d --wait --wait-timeout 600 esignet-db esignet-redis mock-identity-system esignet esignet-ui \
      || { chain_diagnosis; die "eSignet did not become healthy"; }
    if [[ $bff_cli -eq 1 ]]; then
      log "ADR-14 chain: playground esignet-onboard"
      run_cli_esignet esignet-onboard || { chain_diagnosis; die "esignet-onboard failed"; }
      log "ADR-14 chain: mimoto-p12 (openssl, around the key esignet-onboard registered)"
      mimoto_p12
      onboard_state=done
    else
      log "ADR-14 chain: esignet-onboard SKIPPED (bff image not built; deferred: T-07)"
      log "ADR-14 chain: mimoto-p12 via openssl (key kept, p12 rebuilt around it)"
      mimoto_p12
      onboard_state=skipped
    fi
    log "ADR-14 chain: down certify-authcode certify-authcode-nginx mimoto inji-web (never restart)"
    dc rm -s -f certify-authcode certify-authcode-nginx mimoto inji-web >/dev/null 2>&1 || true
    printf '%s\nonboard=%s\n' "$want_marker" "$onboard_state" > "$MARKER"
    write_stamp "$want_marker"
    chain_ran=1
  else
    onboard_state="$(sed -n 's/^onboard=//p' "$MARKER" 2>/dev/null)"
    log "ADR-14 chain: state present for this PUBLIC_HOST/CA, skipped (onboard=$onboard_state)"
    chain_ran=0
  fi
fi

# ---------------------------------------------------------------------- up --
services=()
skipped_build=()
while IFS= read -r s; do
  [[ -n "$s" ]] || continue
  case "$s" in
    bff|sidecar|oauth2-mock)
      ref="interop-playground/$s:local"
      if ! image_present "$ref"; then skipped_build+=("$s"); continue; fi ;;
  esac
  services+=("$s")
done < <(dc config --services)
[[ ${#skipped_build[@]} -gt 0 ]] && log "not started (image not built, --no-build): ${skipped_build[*]}"
# Recovery after `docker compose restart` or a crash (RISK-06): stateless containers that loop or
# went unhealthy are recreated. mosipid/oidc-ui:1.8.0 cannot restart in place: its start script
# fails on the second run ("can't cd to .../plugins/temp", G-126). Stateful services (databases,
# Certify, eSignet, Mimoto) are never recreated here; Mimoto is never restarted (ADR-14).
STATELESS=(esignet-ui inji-web certify-preauth-nginx certify-authcode-nginx certify-mdoc-nginx certify-iae-nginx datashare-service oauth2-mock inji-verify-ui)
for s in "${STATELESS[@]}"; do
  cid="$(dc ps -a -q "$s" 2>/dev/null | head -1)"
  [[ -n "$cid" ]] || continue
  st="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null || true)"
  case "$st" in
    restarting*|exited*|dead*|*unhealthy)
      log "recreating $s (state: $st)"
      dc up -d --no-deps --force-recreate --no-build "$s" >/dev/null 2>&1 || true ;;
  esac
done
log "up: ${#services[@]} services"
dc up -d --wait --wait-timeout 600 --no-build "${services[@]}" || {
  [[ "$mode" == local ]] && chain_diagnosis
  die "the bundle did not become healthy (docker compose -p $PROJECT ps)"
}

if [[ "$mode" == local && "${chain_ran:-0}" -eq 1 && $bff_cli -eq 1 ]]; then
  log "ADR-14 chain: playground certify-didurl"
  run_cli certify-didurl || { chain_diagnosis; die "certify-didurl failed"; }
  log "ADR-14 chain: playground guest-smoke"
  set +e; run_cli guest-smoke; rc=$?; set -e
  if [[ $rc -eq 3 ]]; then
    # Mimoto reaches Certify through the gateway (http://${PUBLIC_HOST}:8093) and resolves the
    # issuer's did:web on 443 (T-11 serves both since build wave 3; G-131 closed)
    chain_diagnosis; die "guest-smoke: the gateway URLs ${PUBLIC_HOST}:8093 / :443 did not answer (bff gateway listeners)"
  elif [[ $rc -ne 0 ]]; then
    chain_diagnosis; die "guest-smoke failed"
  fi
elif [[ "$mode" == local && "${chain_ran:-0}" -eq 1 ]]; then
  log "ADR-14 chain: certify-didurl SKIPPED (per-config did_url is rendered into the init SQL, G-20); guest-smoke SKIPPED (deferred: T-07)"
fi

# ---------------------------------------------- Certify credential configs --
apply_configs() { # <service> <file>...: POST each config whose id is not there yet (idempotent)
  local svc="$1"; shift
  local strict="${STRICT:-1}"
  local f id code
  for f in "$@"; do
    id="$(sed -n 's/.*"credentialConfigKeyId": *"\([^"]*\)".*/\1/p' "$f" | head -1)"
    code="$(dc exec -T "$svc" curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8090/v1/certify/credential-configurations/$id")"
    if [[ "$code" == 200 ]]; then continue; fi
    code="$(dc exec -T "$svc" curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
      --data-binary @- http://127.0.0.1:8090/v1/certify/credential-configurations < "$f")"
    if [[ "$code" != 200 && "$code" != 201 ]]; then
      [[ "$strict" -eq 1 ]] && die "$svc: POST credential configuration $id answered $code"
      warn "$svc: POST credential configuration $id answered $code"; continue
    fi
    log "$svc: credential configuration $id added"
  done
}
cc=.generated/config/certify-preauth/credential-configs
apply_configs certify-preauth "$cc/PlaygroundSdJwt.json" "$cc/DrivingLicenseCredential.json"
if printf '%s\n' "${services[@]}" | grep -qx certify-mdoc; then
  # develop-class image: the spec-shape re-check of 10 §11 item 2 decides its config; warn only
  STRICT=0 apply_configs certify-mdoc "$cc/DrivingLicenseCredential.json"
fi

# --------------------------------------------------------------- readiness --
# ADR-05: backend well-knowns only. Internal names now; gateway URLs once the bff exists.
log "readiness (internal names)"
probe_from=certify-preauth
declare -A PROBES=(
  [certify-preauth]="http://certify-preauth:8090/v1/certify/.well-known/openid-credential-issuer"
  [certify-preauth-nginx]="http://certify-preauth-nginx:80/.well-known/openid-credential-issuer"
  [certify-authcode]="http://certify-authcode:8090/v1/certify/.well-known/openid-credential-issuer"
  [certify-authcode-nginx]="http://certify-authcode-nginx:80/.well-known/openid-credential-issuer"
  [mimoto]="http://mimoto:8099/v1/mimoto/issuers"
  [inji-web]="http://inji-web:3004/v1/mimoto/issuers"
  [verify-service]="http://verify-service:8080/v1/verify/actuator/health"
  [esignet]="http://esignet:8088/v1/esignet/oidc/.well-known/openid-configuration"
  [esignet-ui]="http://esignet-ui:3000/.well-known/openid-configuration"
  [mock-identity-system]="http://mock-identity-system:8082/v1/mock-identity-system/actuator/health"
  [oauth2-mock]="http://oauth2-mock:8095/.well-known/openid-configuration"
  [datashare-service]="http://datashare-service:8097/v1/datashare/get/static-policyid/static-subscriberid/readiness-probe.json"
  [certify-mdoc]="http://certify-mdoc:8090/v1/certify/.well-known/openid-credential-issuer"
  [certify-mdoc-nginx]="http://certify-mdoc-nginx:80/.well-known/openid-credential-issuer"
  [certify-iae]="http://certify-iae:8090/v1/certify/.well-known/openid-credential-issuer"
  [certify-iae-mint]="http://certify-iae-mint:8090/v1/certify/.well-known/openid-credential-issuer"
  [certify-iae-nginx]="http://certify-iae-nginx:82/vp_request_config-dcql-ldp.json"
  [waltid-issuer-api2]="http://waltid-issuer-api2:8080/.well-known/openid-credential-issuer/openid4vci"
  [waltid-verifier-api2]="http://waltid-verifier-api2:8080/"
  [waltid-verifier-api2-signed]="http://waltid-verifier-api2-signed:8080/"
  [eudi-verifier]="http://eudi-verifier:8080/wallet/public-keys.json"
  [sidecar]="http://sidecar:7070/health"
)
# expected status: 200 everywhere except where the probe only proves the server answers
declare -A EXPECT=([datashare-service]=404 [waltid-verifier-api2]=any [waltid-verifier-api2-signed]=any)
failed=0
for s in "${services[@]}"; do
  url="${PROBES[$s]:-}"
  [[ -n "$url" ]] || continue
  deadline=$((SECONDS + 180))
  while :; do
    code="$(dc exec -T "$probe_from" curl -s -o /dev/null -m 5 -w '%{http_code}' "$url" 2>/dev/null || true)"
    want="${EXPECT[$s]:-200}"
    if [[ "$want" == any && "$code" =~ ^[1-5][0-9][0-9]$ ]] || [[ "$code" == "$want" ]]; then
      printf '[up]   %-28s %s  %s\n' "$s" "$code" "$url"; break
    fi
    if [[ $SECONDS -ge $deadline ]]; then
      printf '[up]   %-28s FAIL (%s)  %s\n' "$s" "${code:-no answer}" "$url"; failed=1; break
    fi
    sleep 3
  done
done
if printf '%s\n' "${services[@]}" | grep -qx bff; then
  run_cli wait-ready --timeout 60 "${services[@]}" | sed 's/^/[up]   /' || failed=1
  # the bff probe goes through the published loopback port, so the request guard sees the
  # Host the browser sends (02 §6.3: a container-to-container probe with Host bff:3100 is refused)
  deadline=$((SECONDS + 120))
  while :; do
    code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:3100/api/v1/health 2>/dev/null || true)"
    if [[ "$code" == 200 ]]; then
      printf '[up]   %-28s %s  %s\n' bff "$code" "http://127.0.0.1:3100/api/v1/health"; break
    fi
    if [[ $SECONDS -ge $deadline ]]; then
      printf '[up]   %-28s FAIL (%s)  %s\n' bff "${code:-no answer}" "http://127.0.0.1:3100/api/v1/health"; failed=1; break
    fi
    sleep 2
  done
else
  log "  bff probe (gateway URLs, http://127.0.0.1:3100): SKIPPED, bff image not built (deferred: T-07)"
fi
if printf '%s\n' "${services[@]}" | grep -qx bff; then
  # ADR-05 through the gateway (T-11): the advertised URLs, from the host, with the playground CA
  declare -A GW_PROBES=(
    [certify-preauth]="https://${PUBLIC_HOST}/.well-known/openid-credential-issuer"
    [certify-preauth-did]="https://${PUBLIC_HOST}/.well-known/did.json"
  )
  if [[ "$mode" == local ]]; then
    GW_PROBES+=(
      [certify-authcode]="http://${PUBLIC_HOST}:8093/.well-known/openid-credential-issuer"
      [certify-authcode-did]="https://${PUBLIC_HOST}/authcode/did.json"
      [mimoto]="http://${PUBLIC_HOST}:8099/v1/mimoto/issuers"
      [inji-web]="http://${PUBLIC_HOST}:3004/"
      [esignet]="http://${PUBLIC_HOST}:3005/.well-known/openid-configuration"
      [oauth2-mock]="http://${PUBLIC_HOST}:8095/.well-known/openid-configuration"
      [verify-service]="https://${PUBLIC_HOST}:8443/v1/verify/did.json"
    )
  fi
  for k in $(printf '%s\n' "${!GW_PROBES[@]}" | sort); do
    url="${GW_PROBES[$k]}"
    code="$(curl -s --cacert certs/playground-ca.pem -o /dev/null -m 10 -w '%{http_code}' "$url" 2>/dev/null || true)"
    if [[ "$code" == 200 ]]; then printf '[up]   gateway %-20s %s  %s\n' "$k" "$code" "$url"
    else printf '[up]   gateway %-20s FAIL (%s)  %s\n' "$k" "${code:-no answer}" "$url"; failed=1; fi
  done
fi
[[ $failed -eq 0 ]] || die "readiness probes failed"
# The CA private key never leaves certs/ (02 §2.5): no container may mount it or the whole dir.
if docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
  | xargs -r docker inspect --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' \
  | grep -qE "(/certs/playground-ca\.key|/certs/?)$"; then
  die "a container mounts the CA key or the whole certs/ directory"
fi

# ----------------------------------------------------------------- summary --
log "ready. mode=$mode profiles=${COMPOSE_PROFILES:-core} PUBLIC_HOST=$PUBLIC_HOST"
log "UI: http://127.0.0.1:3100"
[[ "$mode" == local ]] && log "ADR-14 chain onboarding: $onboard_state"
log "digests in use:"
dc config --images 2>/dev/null | sort -u | while IFS= read -r img; do
  case "$img" in
    interop-playground/*) printf '[up]   %s (built locally)\n' "$img" ;;
    *@*) printf '[up]   %s\n' "$img" ;;
    *) printf '[up]   %s@%s\n' "$img" "$(lock_digest "$img")" ;;
  esac
done
[[ " ${withs[*]} " == *" peers "* ]] || log "note: --with peers not given, so the walt.id and EUDI columns are greyed out."
[[ " ${withs[*]} " == *" iae "* ]] || log "note: --with iae not given, so \"Present during issuance\" is greyed out."
