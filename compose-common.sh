#!/usr/bin/env bash

EXAMPLES_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

select_example() {
    case "$1" in
        n8n-simple|n8n-ext-runner-nodejs|n8n-ext-runner-python) ;;
        *)
            printf 'Unknown example: %s\nChoose n8n-simple, n8n-ext-runner-nodejs, or n8n-ext-runner-python.\n' "$1" >&2
            return 2
            ;;
    esac
    if [[ ! -f "$EXAMPLES_ROOT/$1/compose.yaml" ]]; then
        printf 'Missing Compose configuration for %s\n' "$1" >&2
        return 2
    fi
    cd -- "$EXAMPLES_ROOT/$1"
}

select_compose() {
    local candidate
    local candidates=(podman docker)
    if [[ -n "${CONTAINER_RUNTIME:-}" ]]; then
        case "$CONTAINER_RUNTIME" in
            podman|docker) candidates=("$CONTAINER_RUNTIME") ;;
            *)
                printf 'CONTAINER_RUNTIME must be podman or docker.\n' >&2
                return 2
                ;;
        esac
    fi
    for candidate in "${candidates[@]}"; do
        if ! command -v "$candidate" >/dev/null 2>&1; then
            printf '%s is not installed; skipping.\n' "$candidate" >&2
        elif ! "$candidate" info >/dev/null 2>&1; then
            printf '%s is not reachable; check "%s info".\n' "$candidate" "$candidate" >&2
        elif ! "$candidate" compose version >/dev/null 2>&1; then
            printf '%s Compose is unavailable; check "%s compose version".\n' "$candidate" "$candidate" >&2
        else
            COMPOSE_COMMAND=("$candidate" compose)
            printf 'Using %s compose for %s\n' "$candidate" "${PWD##*/}" >&2
            return 0
        fi
    done
    printf 'No usable container runtime with Compose. Start Podman/Docker and install its Compose provider.\n' >&2
    return 1
}

compose() {
    "${COMPOSE_COMMAND[@]}" "$@"
}
