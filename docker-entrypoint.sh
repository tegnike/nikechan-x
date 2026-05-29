#!/bin/sh
set -eu

HERMES_HOME="${HERMES_HOME:-/profile}"

mkdir -p \
  "$HERMES_HOME/logs" \
  "$HERMES_HOME/workspace" \
  "$HERMES_HOME/cache" \
  "$HERMES_HOME/sessions" \
  "$HERMES_HOME/cron/output"

git config --global --add safe.directory "$HERMES_HOME" >/dev/null 2>&1 || true
git config --global user.name "${NIKECHAN_HERMES_GIT_USER_NAME:-nikechan-hermes}" >/dev/null 2>&1 || true
git config --global user.email "${NIKECHAN_HERMES_GIT_USER_EMAIL:-nikechan-hermes@example.local}" >/dev/null 2>&1 || true

exec "$@"
