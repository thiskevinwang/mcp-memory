#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf '%s\n' \
    'Usage: run.sh <remote|local> [wrangler dev options]' \
    '' \
    '  remote  Run the Worker locally with remote AI and Vectorize bindings.' \
    '  local   Run locally without remote bindings. Memory tools are unavailable.'
}

mode="${1:-}"
case "$mode" in
  remote|local)
    shift
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../../.." && pwd)"
cd "$repo_root"

if ! command -v bun >/dev/null 2>&1; then
  printf '%s\n' 'Error: bun is required.' >&2
  exit 1
fi

if [[ ! -d node_modules/wrangler ]]; then
  printf '%s\n' 'Error: dependencies are missing. Run bun install.' >&2
  exit 1
fi

if [[ ! -f .dev.vars ]]; then
  printf '%s\n' 'Error: .dev.vars is missing. See README.md.' >&2
  exit 1
fi

required_vars=(
  CLERK_ISSUER
  MCP_RESOURCE_URL
  CLERK_SECRET_KEY
)

missing_vars=()
for var_name in "${required_vars[@]}"; do
  if ! grep -Eq "^[[:space:]]*${var_name}=[[:space:]]*[^[:space:]#]" .dev.vars; then
    missing_vars+=("$var_name")
  fi
done

if (( ${#missing_vars[@]} > 0 )); then
  printf 'Error: .dev.vars has no value for:' >&2
  printf ' %s' "${missing_vars[@]}" >&2
  printf '\n' >&2
  exit 1
fi

if [[ "$mode" == remote ]]; then
  printf '%s\n' 'Mode: local Worker with remote Cloudflare AI and Vectorize bindings.'
  printf '%s\n' 'Notice: this mode can cause Cloudflare usage.'
  exec bun run dev -- "$@"
fi

printf '%s\n' 'Mode: local Worker without remote bindings.'
printf '%s\n' 'Notice: remember and recall are unavailable in this mode.'
exec bun run dev -- --local "$@"
