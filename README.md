# nikechan-x

AIニケちゃんのX / Another World用 Hermes profile リポジトリです。

このリポジトリはVPS上の live profile そのものです。公開Discord用Hermesが動くサブPCとは別マシンに置きます。

```text
/opt/nikechan-x
```

## 役割

- X投稿、返信、引用、RT判断を担当する
- マスター専用Discordチャンネルから候補ごとのthreadを作り、承認、修正、見送りを扱う
- X向けguard/audit、X専用memory、X API認証情報をこのprofileに閉じる
- 既存VPSの `old X worker` / xangi 経由実装とは独立して、Hermes profileとして最初から構成する

## Another World profile

`profiles/nikechan-another-world/` は、同じ `nikechan-x` Hermes gateway配下で扱う別人格・別surface用profile資材です。xangiには接続しません。

- `skills/elyth-cycle`: ELYTH巡回・返信・投稿候補判断
- `skills/karakuri-turn`: からくりワールド通知に対する1ターン判断
- `skills/world-safety-guard`: ELYTH/からくり向け公開境界guard
- `skills/world-memory-curation`: world-local memory proposal整理
- `scripts/nikechan-another-world.mjs`: live gate付きのWorkflowReport生成CLI

```bash
node scripts/nikechan-another-world.mjs health
node scripts/nikechan-another-world.mjs self-test
node scripts/nikechan-another-world.mjs run --json '{"workflow":"karakuri-turn","surface":"karakuri","mode":"live","requested_by":"manual","context":{"notification":"選択肢: - wait: 待機する"}}'
```

live実行には `NIKECHAN_WORLD_RELEASE_MODE=live` と `NIKECHAN_WORLD_LIVE_ARMED=yes` の両方が必要です。どちらかが欠ける場合は外部実行を止めます。

## Discord Control Channel

```text
1509865603714908304
```

## Git管理するもの

- `config.yaml`: Hermes model/toolset/安全境界
- `profile.yaml`: profile説明
- `SOUL.md`: X用人格・運用境界
- `memories/`: 固定記憶とX運用メモ
- `skills/`: X用Hermes skill
- `cron/jobs.template.json`: Git管理するcron定義テンプレート
- `Dockerfile`, `docker-compose.yml`: VPS上のHermes gateway実行環境
- `systemd/`: systemd service定義
- `scripts/`: installや運用用script

## Git管理しないもの

- `.env`, token, key類
- `state.db*`, `sessions/`, `logs/`, `cache/`
- `cron/jobs.json`
- Hermes bundled skillsやruntime生成物

## 初期運用

1. `.env.example` を参考に、VPS上で `/opt/nikechan-x/.env` を作成する
2. X credentialとSupabase credentialはこのprofileにだけ置く
3. `scripts/install-systemd.sh` を実行する
4. 起動後、マスター専用Discordチャンネルでdry-runから確認する

## Workflow CLI

Hermesはscheduler、Discord受信、thread単位sessionを担当します。このCLIはX投稿境界だけを薄く担当し、候補生成後のguard、pending保存、承認、投稿、記録を行います。

```bash
node scripts/nikechan-x.mjs context --source-mode auto
node scripts/nikechan-x.mjs propose --source-mode presence --candidates-json '[{"text":"...","reason":"..."}]'
node scripts/nikechan-x.mjs notify-pending --thread
node scripts/nikechan-x.mjs resolve --text "1で" --notify
node scripts/nikechan-x.mjs pending
node scripts/nikechan-x.mjs approve --ids 1
node scripts/nikechan-x.mjs cancel --reason "見送り"
node scripts/nikechan-x.mjs mention-context
node scripts/nikechan-x.mjs mention-propose --items-json '{"items":[...]}'
node scripts/nikechan-x.mjs notify-mention-pending --thread
node scripts/nikechan-x.mjs mention-resolve --text "全部OK" --notify
node scripts/nikechan-x.mjs hashtag-context
node scripts/nikechan-x.mjs hashtag-execute --items-json '{"items":[...]}'
node scripts/nikechan-x.mjs doctor
node scripts/nikechan-x.mjs preflight-live
node scripts/nikechan-x.mjs release-mode --set dry-run
```

記録先:

- local: `state/run-state.json`, `state/activity.jsonl`, `state/last-self-tweet-result.json`, `state/pending-mention-reaction.json`, `state/last-mention-reaction-result.json`, `state/last-hashtag-reaction-result.json`
- Supabase best-effort: `tweets`, `twitter_activity_logs`, `twitter_run_state`, `topics`, `local_episodes`

`NIKECHAN_X_RELEASE_MODE=dry-run` の間はX APIを呼びません。`live` / `canary-live` のときだけ投稿します。
live投稿には `NIKECHAN_X_RELEASE_MODE=live` と `NIKECHAN_X_LIVE_ARMED=yes` の両方が必要です。切り替えは明示確認つきCLIで行います。

mention-reaction / hashtag-reaction はdry-run中、X API投稿だけでなく `tweet_logs.checked_by_nikechan`、`nikechan_action`、人物エピソードも更新しません。未チェックログを消費しないため、移行検証後にlive/canary-liveへ切り替えてから本番処理します。

```bash
node scripts/nikechan-x.mjs preflight-live
node scripts/nikechan-x.mjs release-mode --set live --confirm LIVE_X_POSTING
```

`doctor` は非破壊の疎通確認です。Xは `users/me`、DiscordはBotの `users/@me`、Supabaseはreadだけを確認し、秘密値は出力しません。

## Scheduler

VPSではHermes gateway内蔵cronが `/opt/nikechan-x/cron/jobs.json` を読みます。self-tweet / mention-reaction / hashtag-reaction は `no_agent: false` のHermes agent jobとして動き、profile内skillを読み込んでCLIのguard/pending/post境界を呼びます。

通常テキストチャンネルへのcron配送にはHermes標準の「毎回新規thread作成」がないため、候補提示のthread作成だけ `notify-pending --thread` でDiscord APIを使います。thread内の返信処理とsession分離はHermesのDiscord adapterに戻します。

mention-reaction も同じ理由で `notify-mention-pending --thread` が承認threadを作ります。hashtag-reaction は承認待ちを作らず、`hashtag-execute` の結果をcron応答として報告します。

## Commands

```bash
cd /opt/nikechan-x
git status --short
```

Build:

```bash
docker compose build
```

systemd install:

```bash
scripts/install-systemd.sh
```

Gateway status:

```bash
systemctl status ai.hermes.gateway-nikechan-x --no-pager
docker compose logs --tail=100 nikechan-x
```
