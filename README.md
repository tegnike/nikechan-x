# nikechan-x

AIニケちゃんのX運用の道具をまとめたリポジトリです。本番はVPSの次の場所にあります。

```text
/opt/nikechan-x
```

2026-11-19にHermes gatewayをやめ、マスター専用Discord Bot「xangi」（`xangi-max` コンテナ）から直接使う形へ移しました。このディレクトリはxangiコンテナへ同じパスでマウントされます。ELYTH / からくり用の資材とセルフツイートは同日に削除しました。

## 役割分担

| 担当 | 内容 |
|---|---|
| xangi | 定期ジョブの起動（`/opt/nikechan/.xangi/schedules.jsonc` の `sch_x_*`）、承認スレッドでのマスターの返信の受け口 |
| Codex CLI（ChatGPT認証） | 返信するか・RTするかの判断と文章 |
| このリポジトリのCLI | X API、guard、pending保存、記録、Discord通知 |

## 動いている機能

| 機能 | 入口 | 内容 |
|---|---|---|
| AIニュース投稿 | `scripts/x-job.sh ai-news` | 未投稿のAIキャラクターニュースを投稿する。LLMなし |
| メンション返信案 | `scripts/x-job.sh mention-reaction` | メンションへの返信案を作り、Discordの承認スレッドへ出す。承認されるまで投稿しない |
| ハッシュタグ反応 | `scripts/x-job.sh hashtag-reaction` | `#AIニケちゃん` の投稿をRTするか判断して実行し、Discordへ報告する |
| スレッド掃除 | `scripts/x-job.sh cleanup-threads` | 24時間を過ぎたX用Discordスレッドを消す。LLMなし |
| Xメモリ | `nikechan-x-memory.timer` → `scripts/x-memory-worker.mjs` | Xでのやり取りから記憶を作り、Supabaseへ保存する |

`x-job.sh` は同じジョブの重複起動を防ぎ、候補が0件ならCodexを起動しません。Codexを使ったジョブのログは `logs/x-jobs/` に直近200件残ります。

## 置いてあるもの

- `scripts/nikechan-x.mjs`: X運用CLI
- `scripts/x-job.sh`: 定期ジョブの入口
- `scripts/x-memory-*.mjs`, `scripts/lib-x-memory-*.mjs`, `scripts/x-memory-codex-model.py`: Xメモリ
- `profiles/nikechan-x/SOUL.md`: X上のAIニケちゃんの人格と公開境界
- `profiles/nikechan-x/skills/x-mention-reaction/`, `x-hashtag-reaction/`: Codexが読む方針と手順
- `docs/`: AIニュースへの質問返信、保存の復旧、Xメモリの一括取り込みの記録
- `deploy/sql/`: Supabase用SQL
- `test/`, `tests/`: `node --test test/*.mjs tests/*.mjs`

Git管理しないもの: `.env`、`.xangi/`（xAIの認証情報）、`state/`、`logs/`、`tmp/`、`discord_threads.json`、`node_modules/`

## CLI

```bash
node scripts/nikechan-x.mjs ai-news-tweet --notify --thread
node scripts/nikechan-x.mjs mention-context
node scripts/nikechan-x.mjs mention-propose --items-json '{"items":[...]}'
node scripts/nikechan-x.mjs notify-mention-pending --thread
node scripts/nikechan-x.mjs mention-resolve --text "全部OK" --thread-id <id> --notify
node scripts/nikechan-x.mjs mention-approve --thread-id <id> --ids m1
node scripts/nikechan-x.mjs thread-context --thread-id <id>
node scripts/nikechan-x.mjs hashtag-context
node scripts/nikechan-x.mjs hashtag-execute --items-json '{"items":[...]}' --notify --thread
node scripts/nikechan-x.mjs cleanup-threads
node scripts/nikechan-x.mjs state
node scripts/nikechan-x.mjs doctor
node scripts/nikechan-x.mjs preflight-live
node scripts/nikechan-x.mjs release-mode --set dry-run
```

記録先:

- ローカル: `state/run-state.json`, `state/activity.jsonl`, `state/pending-mention-reaction.json`, `state/last-*-result.json`
- Supabase（失敗しても処理は続ける）: `tweets`, `twitter_activity_logs`, `twitter_run_state`, `local_episodes`

`NIKECHAN_X_RELEASE_MODE=dry-run` の間はX APIを呼びません。投稿には `NIKECHAN_X_RELEASE_MODE=live` と `NIKECHAN_X_LIVE_ARMED=yes` の両方が必要です。切り替えは確認つきのCLIで行います。

```bash
node scripts/nikechan-x.mjs preflight-live
node scripts/nikechan-x.mjs release-mode --set live --confirm LIVE_X_POSTING
```

dry-run中のメンション反応・ハッシュタグ反応は、X投稿だけでなく `tweet_logs` のチェック済み更新と人物エピソードも書きません。

## 確認

```bash
# xangiコンテナの中から手で動かす
docker exec -w /opt/nikechan-x xangi-max scripts/x-job.sh cleanup-threads

# 定期ジョブの実行履歴
grep sch_x_ /opt/nikechan/.xangi/logs/scheduler.jsonl | tail

# Xメモリ
systemctl status nikechan-x-memory.timer --no-pager
docker exec -w /opt/nikechan-x xangi-max node scripts/x-memory-status.mjs
```

ファイルの所有者は `alice`（uid 1000、xangiコンテナ内の実行ユーザーと同じ）です。gitは `sudo -u alice git ...` で操作します。
