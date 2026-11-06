#!/usr/bin/env bash
set -euo pipefail

source "$(dirname -- "${BASH_SOURCE[0]}")/compose-common.sh"

usage() {
    printf 'Usage: %s <example-directory> [up|stop|down|ps|logs|config]\n' "${0##*/}"
    printf 'Examples: n8n-simple, n8n-ext-runner-nodejs, n8n-ext-runner-python\n'
    printf 'Default action: up. Run build.sh first to prepare images.\n'
    printf 'down preserves named volumes. Optional: CONTAINER_RUNTIME=podman|docker\n'
}

if [[ $# -eq 1 && ( "$1" == --help || "$1" == -h ) ]]; then
    usage
    exit 0
fi
if [[ $# -lt 1 || $# -gt 2 ]]; then
    usage >&2
    exit 2
fi
action="${2:-up}"
case "$action" in
    up|stop|down|ps|logs|config) ;;
    *)
        printf 'Unknown action: %s\n' "$action" >&2
        usage >&2
        exit 2
        ;;
esac

select_example "$1"
select_compose
case "$action" in
    up)
        compose config --quiet
        compose up -d --no-build --pull never
        ;;
    logs) compose logs -f --tail 100 ;;
    config) compose config --quiet ;;
    *) compose "$action" ;;
esac
