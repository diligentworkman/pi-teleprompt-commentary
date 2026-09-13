#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
temporary_parent="${TMPDIR:-/tmp}"
test_root="$(mktemp -d -- "$temporary_parent/pi-prompt-commentary-manual.XXXXXX")"
primary_workspace="$test_root/primary"
pi_executable="$project_root/node_modules/.bin/pi"
shell_rc="$test_root/bashrc"

cleanup() {
  rm -rf -- "$test_root"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ ! -x "$pi_executable" ]]; then
  printf 'Pi executable not found at %s\n' "$pi_executable" >&2
  exit 1
fi

mkdir -- "$primary_workspace"
cat > "$shell_rc" <<'EOF'
if [[ -f "$HOME/.bashrc" ]]; then
  source "$HOME/.bashrc"
fi

pi-tc() {
  "$PI_TELEPROMPT_PI" -e "$PI_TELEPROMPT_PROJECT_ROOT" "$@"
}
EOF

export PI_TELEPROMPT_PROJECT_ROOT="$project_root"
export PI_TELEPROMPT_TEST_ROOT="$test_root"
export PI_TELEPROMPT_PRIMARY_WORKSPACE="$primary_workspace"
export PI_TELEPROMPT_PI="$pi_executable"

printf '\nManual Pi test environment\n'
printf '  Project:           %s\n' "$PI_TELEPROMPT_PROJECT_ROOT"
printf '  Temporary root:    %s\n' "$PI_TELEPROMPT_TEST_ROOT"
printf '  Primary workspace: %s\n' "$PI_TELEPROMPT_PRIMARY_WORKSPACE"
printf '\nAll manual test artifacts must remain below the temporary root.\n'
printf 'Create scenario-specific workspaces and fixtures from this shell.\n'
printf '\nStart Pi with the prepared command:\n'
printf '  pi-tc\n'
printf '%s\n' "While Pi is running, suspend it with Ctrl-Z, perform setup in this shell, then run 'fg' to resume it."
printf 'The temporary root is removed only after you exit this interactive shell.\n\n'

cd -- "$primary_workspace"
bash --rcfile "$shell_rc" -i
