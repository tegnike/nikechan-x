#!/usr/bin/env bash
set -euo pipefail

cd /profile
node scripts/nikechan-x.mjs cleanup-threads --json >/tmp/nikechan-x-thread-cleanup.json
echo '{"wakeAgent":false}'
