---
name: x-hashtag-reaction
description: #AIニケちゃん タグの未チェックツイートを収集し、RTまたはスキップを自律判断して事後報告する。
---

# x-hashtag-reaction

## 使うCLI

HermesはRT/skip判断を担当し、X投稿境界・guard・記録はprofile内CLIに任せる。

```bash
node scripts/nikechan-hermes.mjs hashtag-context
node scripts/nikechan-hermes.mjs hashtag-execute --items-json '<json>' --notify --thread
```

## 方針

- このworkflowでは返信・引用RTは行わない
- 承認待ちは作らず、RT/skipを自律判断して結果だけ報告する
- 候補生成前に必ず `hashtag-context` を読む
- `hashtag-context.candidates[].personContext` と `mediaContext` を判断材料にする
- ファンアート、3D/動画作品、応援・紹介、イベント告知はRT候補
- bot系自動投稿、ニケちゃんと直接関係が薄い内容、スパム、不適切な内容はskip
- メディア取得に失敗している場合は本文と人物文脈だけで保守的に判断する
- Discordコマンド、チャンネルメンション、内部運用語、secret、private path は出さない
- 判断後は必ず `hashtag-execute --notify --thread` に渡し、CLIの投稿境界とDiscord thread報告を通す

## 判断JSON

`hashtag-execute` には次の形で渡す。

```json
{
  "items": [
    {
      "id": "h1",
      "tweetLogId": "tweet_logs.id",
      "postId": "相手ツイートID",
      "username": "username",
      "displayName": "表示名",
      "body": "相手の本文",
      "action": "retweet",
      "reason": "ファンアートのため"
    }
  ]
}
```

## dry-run / live

`NIKECHAN_X_RELEASE_MODE=dry-run` ではX API投稿も `tweet_logs` 消費も行わない。
`live` または `canary-live` かつ `NIKECHAN_X_LIVE_ARMED=yes` のときだけ、RT・checked更新・action記録・contact episode記録を行う。
