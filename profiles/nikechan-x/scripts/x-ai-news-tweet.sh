#!/usr/bin/env bash
set -euo pipefail

cd /profile
node scripts/nikechan-x.mjs ai-news-tweet --notify --thread --json
echo '{"wakeAgent":false}'
