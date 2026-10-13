#!/usr/bin/env bash
# Render docker/config/** into <out>/<service>/ (10 §8.1 step 5).
#
#   docker/render-config.sh <out-dir>
#
# Rules (shared with `playground render-config` in the bff image, which must produce the same tree):
#  - every file is copied; a file ending in `.tmpl` has the whitelisted variables below substituted
#    and loses the suffix; a file ending in `.b64` is base64-decoded and loses the suffix;
#  - only these names are substituted, written as ${NAME}: PUBLIC_HOST, CERTIFY_DID_URL,
#    WALTID_VERIFIER_DID, WALTID_VERIFIER_KEY_JWK. Every other ${...} (Spring, HOCON, nginx)
#    is left untouched;
#  - a whitelisted variable that a template uses but that is empty stops the render;
#  - after rendering, no whitelisted ${NAME} may remain in any output file.
# Inputs come from the environment: PUBLIC_HOST (required), WALTID_VERIFIER_DID and
# WALTID_VERIFIER_KEY_JWK (required by waltid-verifier-signed). CERTIFY_DID_URL is set per
# Certify instance by this script. Needs bash 4+ only (no envsubst, no jq).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/config"
out="${1:?usage: render-config.sh <out-dir>}"
: "${PUBLIC_HOST:?PUBLIC_HOST must be set}"

VARS=(PUBLIC_HOST CERTIFY_DID_URL WALTID_VERIFIER_DID WALTID_VERIFIER_KEY_JWK)

render_file() { # <src-file> <dst-file-without-suffix>
  local f="$1" dst="$2" content name val
  content="$(cat "$f"; printf x)"
  content="${content%x}"
  for name in "${VARS[@]}"; do
    if [[ "$content" == *"\${$name}"* ]]; then
      val="${!name:-}"
      if [[ -z "$val" ]]; then
        echo "render-config: $f needs \${$name}, which is empty" >&2
        return 1
      fi
      content="${content//\$\{$name\}/$val}"
    fi
  done
  printf '%s' "$content" > "$dst"
}

render_dir() { # <src-dir> <dst-dir>
  local s="$1" d="$2" f rel target
  [[ -d "$s" ]] || { echo "render-config: missing $s" >&2; return 1; }
  while IFS= read -r -d '' f; do
    rel="${f#"$s"/}"
    target="$d/$rel"
    mkdir -p "$(dirname "$target")"
    case "$f" in
      *.tmpl) render_file "$f" "${target%.tmpl}" ;;
      *.b64) base64 -d < "$f" > "${target%.b64}" ;;
      *) cp "$f" "$target" ;;
    esac
  done < <(find "$s" -type f -print0 | sort -z)
}

# Start from an empty tree so a deleted template never leaves a stale rendered file behind.
mkdir -p "$out"
for d in "$out"/*/; do
  [[ -d "$d" ]] && rm -rf -- "${d:?}"
done

certify() { # <service> <did-url>
  CERTIFY_DID_URL="$2" render_dir "$src/certify-common" "$out/$1"
  CERTIFY_DID_URL="$2" render_dir "$src/$1" "$out/$1"
}
certify certify-preauth "did:web:${PUBLIC_HOST}"
certify certify-authcode "did:web:${PUBLIC_HOST}:authcode"
certify certify-mdoc "did:web:${PUBLIC_HOST}:mdoc"
certify certify-iae "did:web:${PUBLIC_HOST}:iae"
certify certify-iae-mint "did:web:${PUBLIC_HOST}:iae"

for svc in mimoto inji-web verify esignet esignet-ui waltid-issuer waltid-verifier waltid-verifier-signed eudi; do
  render_dir "$src/$svc" "$out/$svc"
done

# Gate: no whitelisted placeholder survives.
left="$(grep -rlE '\$\{(PUBLIC_HOST|CERTIFY_DID_URL|WALTID_VERIFIER_DID|WALTID_VERIFIER_KEY_JWK)\}' "$out" || true)"
if [[ -n "$left" ]]; then
  echo "render-config: unresolved variables in: $left" >&2
  exit 1
fi
echo "render-config: rendered $(find "$out" -type f | wc -l) files into $out"
