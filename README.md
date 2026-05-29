# nikechan-x

AIニケちゃんのX専用 Hermes profile リポジトリです。

このリポジトリはサブMac上の live profile そのものです。

```text
/Users/nikenike/.hermes/profiles/nikechan-x
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
- `launchd/`: LaunchDaemon定義
- `scripts/`: installや運用用script

## Git管理しないもの

- `.env`, token, key類
- `state.db*`, `sessions/`, `logs/`, `cache/`
- `cron/jobs.json`
- Hermes bundled skillsやruntime生成物

## 初期運用

1. `.env.example` を参考に、サブMac上で `.env` を作成する
2. X credentialとDiscord credentialはDiscord公開profileとは別にする
3. `launchd/ai.hermes.gateway-nikechan-x.plist` をinstallする
4. 起動後、マスター専用Discordチャンネルでdry-runから確認する

## Commands

```bash
cd /Users/nikenike/.hermes/profiles/nikechan-x
git status --short
```

LaunchDaemon install:

```bash
scripts/install-launchdaemon.sh
```

Gateway status:

```bash
launchctl print system/ai.hermes.gateway-nikechan-x
tail -n 100 logs/gateway.log
```
