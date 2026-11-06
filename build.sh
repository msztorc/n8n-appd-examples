#!/usr/bin/env bash
set -euo pipefail

source "$(dirname -- "${BASH_SOURCE[0]}")/compose-common.sh"

usage() {
    printf 'Usage: %s <example-directory>\n' "${0##*/}"
    printf 'Examples: n8n-simple, n8n-ext-runner-nodejs, n8n-ext-runner-python\n'
    printf 'Pulls prebuilt images; also builds the custom Python runner when selected.\n'
    printf 'Does not start services. Optional: CONTAINER_RUNTIME=podman|docker\n'
}

if [[ $# -eq 1 && ( "$1" == --help || "$1" == -h ) ]]; then
    usage
    exit 0
fi
if [[ $# -ne 1 ]]; then
    usage >&2
    exit 2
fi

select_example "$1"
select_compose
compose config --quiet
if [[ "$1" == n8n-ext-runner-python ]]; then
    compose pull --ignore-buildable
    compose build task-runners
else
    compose pull
fi
