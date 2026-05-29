---
name: x-mention-reaction
description: Xの未チェックreply/quote/@メンションを収集し、返信・引用RT・スキップ候補を作ってマスター承認に回す。
---

# x-mention-reaction

## 使うCLI

Hermesは判断と文章生成を担当し、X投稿境界・pending state・guard・記録はprofile内CLIに任せる。

```bash
node scripts/nikechan-hermes.mjs mention-context
node scripts/nikechan-hermes.mjs mention-propose --items-json '<json>'
node scripts/nikechan-hermes.mjs notify-mention-pending --thread
node scripts/nikechan-hermes.mjs mention-resolve --text "<Discord返信本文>" --notify
node scripts/nikechan-hermes.mjs mention-pending
node scripts/nikechan-hermes.mjs mention-approve --ids m1,m2
node scripts/nikechan-hermes.mjs mention-cancel --reason "<理由>"
```

## 方針

- マスター承認なしに返信・引用RTを実行しない
- 候補生成前に必ず `mention-context` を読む
- `mention-context.candidates[].personContext` は公開可能な投影だけとして扱う
- 相手を名前で呼ぶ場合は `nickname` だけをそのまま使う
- `nickname` が空の場合は相手を名前で呼ばない
- 返信と引用RTは別軸で判断するが、過剰反応は避ける
- 不適切、文脈不足、内輪の運用品質指摘、反応不要なものは skip
- Discordコマンド、チャンネルメンション、内部運用語、secret、private path は出さない
- 候補生成後は必ず `mention-propose` に渡し、guardとpending保存を通す
- cron実行時は `mention-propose` 後に `notify-mention-pending --thread` を実行し、最終応答は `[SILENT]` にする
- 既存pendingがある場合は新規候補を作らず、必要なら `notify-mention-pending --thread` だけ行って `[SILENT]` にする

## 候補JSON

`mention-propose` には次の形で渡す。

```json
{
  "items": [
    {
      "id": "m1",
      "tweetLogId": "tweet_logs.id",
      "postId": "相手ツイートID",
      "username": "username",
      "displayName": "表示名",
      "type": "reply",
      "body": "相手の本文",
      "originalTweetId": "元ツイートID。なければ省略",
      "originalTweetText": "元ツイート本文。なければ省略",
      "replyAction": "reply",
      "quoteAction": "skip",
      "reason": "判断理由",
      "replyText": "返信本文"
    }
  ]
}
```

## 承認時

マスターが「全部OK」「1だけ」「m1で」「リプして」など明確に承認した場合だけ:

```bash
node scripts/nikechan-hermes.mjs mention-resolve --text "全部OK" --notify
```

`NIKECHAN_X_RELEASE_MODE=dry-run` ではX API投稿も `tweet_logs` 消費も行わない。
`live` または `canary-live` かつ `NIKECHAN_X_LIVE_ARMED=yes` のときだけ、投稿・checked更新・action記録・contact episode記録を行う。

## 修正時

`mention-resolve` が `revise` を返したら、保存された `mention-context` の `currentItems` と `feedback` を読み、全候補を作り直して `mention-propose` に渡す。
