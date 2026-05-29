---
name: nikechan-x-self-tweet
description: AIニケちゃんのXセルフツイート候補を作る。マスター専用Discordで承認を受ける前提で、public-safeな話題だけを短いX投稿案にする。
---

# nikechan-x-self-tweet

## 使うCLI

Hermes本体は変更しない。Hermesのscheduler/session/Discord受信を優先し、X投稿境界だけprofile内CLIを使う。

```bash
node scripts/nikechan-x.mjs context --source-mode auto
node scripts/nikechan-x.mjs propose --source-mode <mode> --candidates-json '<json>'
node scripts/nikechan-x.mjs notify-pending --thread
node scripts/nikechan-x.mjs resolve --text "<Discord返信本文>" --notify
node scripts/nikechan-x.mjs pending
node scripts/nikechan-x.mjs approve --ids <番号>
node scripts/nikechan-x.mjs cancel --reason "<理由>"
node scripts/nikechan-x.mjs preflight-live
```

## 方針

- 候補提示を優先し、初期状態では直接投稿しない
- public-safeな近況、公開済み投稿、公開記事、X上の現在文脈だけを材料にする
- secret、内部ログ、privateな人物文脈、未公開作業内容を混ぜない
- 候補は短く、Xで単体で読める文にする
- cron実行時はHermes agent jobとして動く。通知後の最終応答は `[SILENT]` にして、Hermes cronの通常配送で重複通知しない
- cron実行時は最初に `state --json` を確認する。既存pendingに `threadId` がある場合は新規候補も新規threadも作らず `[SILENT]` を返す
- 既存pendingがあり `threadId` がない場合だけ `notify-pending --thread` でthread化し、`[SILENT]` を返す
- 候補生成前に必ず `context` を読む
- `context.materials.primary` を主材料にする。`context.materials.supporting` は補助だけに使う
- `context.duplicateReference` に近い話題・言い回しは作らない。禁止リスト管理ではなく、その場の重複参照として扱う
- 候補生成後は必ず `propose` に渡し、guardとpending保存を通す
- `propose` 後は `notify-pending --thread` を実行し、候補ごとのDiscord threadを作って候補全文を提示する
- マスターがthread内で番号承認・修正・見送りを返信した場合は、本文を `resolve --text` に渡して判定と記録をCLIに任せる
- `resolve` が `revise` を返した場合だけ、feedbackを反映した新しい候補を作り直して `propose` する
- 修正指示の場合は、既存pendingを参考に新しい候補を作り直して `propose` し、同じthreadへ `notify-pending --thread` ではなく `pending` の内容を返す

## 候補JSON

`propose` には次の形で渡す。

```json
[
  {
    "text": "投稿本文",
    "reason": "この候補の狙い",
    "sourceRefs": [{"type": "memory", "label": "任意"}]
  }
]
```

## 承認時

マスターが「1で」「1番」「投稿して」「OK」など明確に承認した場合だけ:

```bash
node scripts/nikechan-x.mjs resolve --text "1で" --notify
```

`NIKECHAN_X_RELEASE_MODE=dry-run` ならX APIは呼ばず、記録だけ行う。
`live` または `canary-live` かつ `NIKECHAN_X_LIVE_ARMED=yes` のときだけX API投稿を実行する。
liveへ切り替える前は `preflight-live` で疎通、pending、guardを確認する。

## 見送り時

```bash
node scripts/nikechan-x.mjs cancel --reason "マスターが見送り"
```
