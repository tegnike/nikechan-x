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
- `body` と `originalTweetText` は `mention-context.candidates[]` の原文をそのまま使い、要約・翻訳しない
- `reason` / `replyText` / `quoteText` は必ず日本語で書く
- 返信と引用RTは別軸で判断するが、過剰反応は避ける
- 不適切、文脈不足、内輪の運用品質指摘、反応不要なものは skip
- Discordコマンド、チャンネルメンション、内部運用語、secret、private path は出さない
- 候補生成後は必ず `mention-propose` に渡し、guardとpending保存を通す
- cron実行時は `mention-propose` 後に `notify-mention-pending --thread` を実行し、最終応答は `[SILENT]` にする
- `mention-context` の `candidates` が空で、既存pendingだけがある場合は何も通知せず `[SILENT]` にする
- `mention-context` の `candidates` がある場合は、既存pendingがあっても必ず新しい候補を作って `mention-propose` に渡す。CLIが古いpendingをsupersededとして退避する
- `existingPending.threadId` または `existingPending.notifiedAt` がある既存pendingに対して、`notify-mention-pending --thread` だけを再実行しない

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
      "body": "相手の本文を原文コピー（要約・翻訳禁止）",
      "originalTweetId": "元ツイートID。なければ省略",
      "originalTweetText": "元ツイート本文を原文コピー。なければ省略",
      "replyAction": "reply",
      "quoteAction": "skip",
      "reason": "日本語の判断理由",
      "replyText": "日本語の返信本文"
    }
  ]
}
```

## Discord承認・修正thread

候補thread内のマスター返信は、固定文言ではなくLLM判断で扱う。

- 「どうぞ」「お願い」「そのまま」「これで」「いいよ」など、現在候補を進める意図なら承認として扱う
- 番号や `m1` / `m2` 指定があれば該当候補だけ、指定がなければ現在提示中の実行対象を承認する
- 承認時は `node scripts/nikechan-hermes.mjs mention-approve --ids m1,m2` を実行し、結果を短く報告する
- 「ここをこう変えて」「もう少し柔らかく」「この文だけ直して」などは修正指示として扱う
- 修正時は現在の `pending.items` と `pending.candidates` を元に全候補JSONを作り直し、`node scripts/nikechan-hermes.mjs mention-propose --preserve-thread true --items-json '<json>'` を実行する
- 質問・確認・ログ確認なら投稿せず、短く答えて pending を維持する
- メンション反応threadでは self-tweet pending を実行しない
- Discordへの返答では、内部コマンド、pending ID、`needs_approval`、JSON、実行ログを通常は出さない。マスターがログ確認を求めた場合だけ最小限に出す
- 修正後は「了解しました。では雰囲気を変えて以下のような案でどうでしょう。」のような自然な短文と、変更後の候補本文だけを返す
- 承認・投稿後は投稿済みURLだけを簡潔に返す

補助コマンド:

```bash
node scripts/nikechan-hermes.mjs thread-context --thread-id "<Discord thread id>"
node scripts/nikechan-hermes.mjs mention-resolve --text "<Discord返信本文>" --notify
```

`mention-resolve` は補助用。thread返信の主判断はLLMが行い、承認なら `mention-approve`、修正なら `mention-propose --preserve-thread true` を直接使う。

`NIKECHAN_X_RELEASE_MODE=dry-run` ではX API投稿も `tweet_logs` 消費も行わない。
`live` または `canary-live` かつ `NIKECHAN_X_LIVE_ARMED=yes` のときだけ、投稿・checked更新・action記録・contact episode記録を行う。

## 修正時

保存された `mention-context` または thread router から渡された `pending` の `currentItems` / `items` と `feedback` を読み、全候補を作り直して `mention-propose --preserve-thread true` に渡す。
