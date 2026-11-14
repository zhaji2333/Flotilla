#!/bin/sh
# Move the PostgreSQL password out of the process environment before the
# worker/planner controller starts. The child Harness process inherits only a
# path to a mode-0600 file that the controller unlinks immediately after the
# pool is created, so a shell inside the worker cannot read the controller's
# credentials from /proc/1/environ.
set -eu
if [ -n "${PG_PASSWORD:-}" ]; then
  secret_file="${PG_PASSWORD_FILE:-/tmp/.src-agent-pg-password}"
  umask 077
  printf '%s' "$PG_PASSWORD" > "$secret_file"
  unset PG_PASSWORD
  export PG_PASSWORD_FILE="$secret_file"
fi
exec "$@"
