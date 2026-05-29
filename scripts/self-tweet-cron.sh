#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

python3 -m hermes_cli.main \
  --provider "${HERMES_INFERENCE_PROVIDER:-xai}" \
  -m "${HERMES_INFERENCE_MODEL:-grok-3-mini}" \
  -t terminal \
  --skills nikechan-x-self-tweet \
  --accept-hooks \
  --yolo \
  -z "nikechan-x-self-tweetスキルを使って、公開して問題ないXセルフツイート候補を2件作ってください。必ず node scripts/nikechan-x.mjs context --source-mode auto を読み、node scripts/nikechan-x.mjs propose を実行し、その直後に node scripts/nikechan-x.mjs notify-pending を実行してください。投稿やapproveは絶対に実行しないでください。既にpendingがある場合は新規作成せず notify-pending だけ実行してください。[SILENT]は禁止です。最後にpending IDだけ報告してください。"
