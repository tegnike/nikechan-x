# nikechan-x

AIニケちゃんのX専用 Hermes profile リポジトリです。

このリポジトリはVPS上の live profile そのものです。公開Discord用Hermesが動くサブPCとは別マシンに置きます。

```text
/opt/nikechan-x
```

## 役割

- X投稿、返信、引用、RT判断を担当する
- マスター専用Discordチャンネルで候補提示、承認、修正、見送りを扱う
- X向けguard/audit、X専用memory、X API認証情報をこのprofileに閉じる
- 既存VPSの `nikechan-x-worker` / xangi 経由実装とは独立して、Hermes profileとして最初から構成する

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

HermesはこのCLIを呼んで、候補生成後のguard、pending保存、承認、投稿、記録を行います。

```bash
node scripts/nikechan-x.mjs context --source-mode auto
node scripts/nikechan-x.mjs propose --source-mode presence --candidates-json '[{"text":"...","reason":"..."}]'
node scripts/nikechan-x.mjs notify-pending
node scripts/nikechan-x.mjs pending
node scripts/nikechan-x.mjs approve --ids 1
node scripts/nikechan-x.mjs cancel --reason "見送り"
node scripts/nikechan-x.mjs doctor
```

記録先:

- local: `state/run-state.json`, `state/activity.jsonl`, `state/last-self-tweet-result.json`
- Supabase best-effort: `tweets`, `twitter_activity_logs`, `twitter_run_state`, `topics`, `local_episodes`

`NIKECHAN_X_RELEASE_MODE=dry-run` の間はX APIを呼びません。`live` / `canary-live` のときだけ投稿します。

`doctor` は非破壊の疎通確認です。Xは `users/me`、DiscordはBotの `users/@me`、Supabaseはreadだけを確認し、秘密値は出力しません。

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
