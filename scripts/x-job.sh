#!/usr/bin/env bash
# AIニケちゃんのX運用の定期ジョブ。xangiのスケジューラーからcommandとして呼ばれる。
#
#   scripts/x-job.sh ai-news           未投稿のAIキャラクターニュースを投稿する（LLMなし）
#   scripts/x-job.sh cleanup-threads   24時間を過ぎたX用Discordスレッドを消す（LLMなし）
#   scripts/x-job.sh mention-reaction  メンションへの返信候補を作り、承認スレッドへ出す（Codex）
#   scripts/x-job.sh hashtag-reaction  #AIニケちゃん の投稿をRTするか判断して実行する（Codex）
#
# 判断と文章はCodex CLI（ChatGPT認証）が担当し、X投稿境界・検査・pending保存・Discord通知は
# scripts/nikechan-x.mjs が担当する。成功時は何も出力しない。失敗時は非0で終了し、
# xangiがエラーとして通知する。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
job="${1:?usage: x-job.sh <ai-news|cleanup-threads|mention-reaction|hashtag-reaction>}"
CLI=(node scripts/nikechan-x.mjs)
LOG_DIR="$ROOT/logs/x-jobs"
mkdir -p "$LOG_DIR" "$ROOT/state"

# 同じジョブの重複起動を防ぐ
exec 9>"$ROOT/state/.x-job-$job.lock"
if ! flock -n 9; then
  echo "x-job $job: previous run is still active" >&2
  exit 1
fi

candidate_count() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);console.log(Array.isArray(d.candidates)?d.candidates.length:0)})'
}

run_codex() {
  local skill="$1" task="$2"
  local stamp log
  stamp="$(date +%Y%m%d-%H%M%S)"
  log="$LOG_DIR/$job-$stamp.log"
  local prompt
  prompt="$(cat <<EOF
あなたはAIニケちゃんのX運用を担当します。これは定期実行で、人間は見ていません。

## 準備
1. $ROOT/profiles/nikechan-x/SOUL.md を読む（X上のAIニケちゃんの人格と公開境界）。
2. $ROOT/profiles/nikechan-x/skills/$skill/SKILL.md を読み、その方針と手順に従う。

## 今回の作業
$task

## 決まり
- CLIは必ず $ROOT で \`node scripts/nikechan-x.mjs ...\` として実行する。
- X投稿境界・検査・pending保存・記録・Discord通知はCLIが担当する。X APIやDiscord APIを直接呼ばない。state配下のファイルを手で書き換えない。CLIやスキルのファイルを編集しない。
- 画像・動画の確認が必要な候補は、メディアを一時ディレクトリへ保存して自分の目で内容を確認する。確認できなければスキルの指示どおりskipにする。
- 最後に、実行したCLIコマンドと結果を3行以内で報告する。
EOF
)"
  if ! codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral \
      --cd "$ROOT" --model "${NIKECHAN_X_CODEX_MODEL:-gpt-6.1-sol}" \
      -c "model_reasoning_effort=\"${NIKECHAN_X_CODEX_EFFORT:-medium}\"" \
      "$prompt" >"$log" 2>&1 </dev/null; then
    echo "x-job $job: codex failed (log: $log)" >&2
    tail -n 20 "$log" >&2
    exit 1
  fi
  # 直近200件だけ残す
  ls -1t "$LOG_DIR"/*.log 2>/dev/null | tail -n +201 | xargs -r rm -f
}

case "$job" in
  ai-news)
    "${CLI[@]}" ai-news-tweet --notify --thread --json >"$ROOT/state/last-ai-news-job.json"
    ;;
  cleanup-threads)
    "${CLI[@]}" cleanup-threads --json >"$ROOT/state/last-thread-cleanup-job.json"
    ;;
  mention-reaction)
    # 候補がなければCodexを起動しない
    count="$("${CLI[@]}" mention-context --json | candidate_count)"
    [ "$count" -gt 0 ] || exit 0
    run_codex x-mention-reaction "メンション反応候補を作成してください。\`mention-context\` を読み、候補ごとに返信・引用RT・skipを判断して \`mention-propose\` でguardとpending保存を通し、\`notify-mention-pending --thread\` でDiscordの承認スレッドへ提示します。明確な承認なしにX返信・引用RTは実行しません（\`mention-approve\` は実行しない）。"
    ;;
  hashtag-reaction)
    count="$("${CLI[@]}" hashtag-context --json | candidate_count)"
    [ "$count" -gt 0 ] || exit 0
    run_codex x-hashtag-reaction "ハッシュタグ反応を実行してください。\`hashtag-context\` で未チェックの #AIニケちゃん 候補を読み、RT/skipを判断し、\`hashtag-execute --notify --thread\` を通して結果をDiscordスレッドへ報告します。"
    ;;
  *)
    echo "x-job: unknown job: $job" >&2
    exit 2
    ;;
esac
