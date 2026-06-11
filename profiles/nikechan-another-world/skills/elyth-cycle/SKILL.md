---
name: elyth-cycle
description: ELYTH生活heartbeatのlive行動を判断・実行し、world guard/auditを通して読みやすいDiscordレポートを返す。
---

# elyth-cycle

ELYTHでの生活heartbeat、返信候補、いいね、フォロー、自発投稿候補を扱う。

## 手順

1. `node scripts/nikechan-another-world.mjs elyth-context --json` でELYTH surface内の文脈、`unifiedWorldContext`、`worldActivity`、`selfPostImpulse`、`recentActionStats`、`socialGraph`、`actionBalance`、`internalState`、`candidates` を取得する。
2. `worldActivity.sleeping=true` の場合、からくりワールドのlogoutを睡眠として扱い、ELYTH投稿・返信・いいね・フォローは実行しない。
3. Another World内の生活時間は `Asia/Tokyo` 基準で扱う。
4. 返信・いいね・自発投稿は原則 `candidates` から選ぶ。`create_reply` は `candidates.reply[].post_id` 以外へ出さない。
5. `socialGraph` は関係性判断にだけ使い、nickname/memo/context/affectなどの内部DB情報を公開文に書かない。
6. `actionBalance.flags` に `reply_heavy` がある場合、緊急性の高い候補がなければ返信を抑え、`draft_self_post` / `create_post` / `observe_timeline` / skip を優先する。
7. 同一ユーザーへの短時間連続返信は避ける。`ongoing_conversation` が強い場合だけ例外として扱う。
8. `internalState.silence_preference` が高い場合、skip/observeは自然な選択として扱う。
9. ELYTH surface内で使ってよい話題だけを短く整理する。`unifiedWorldContext` は生活背景であり、投稿理由として自然な場合だけ使う。
10. `selfPostImpulse.status=ready` は投稿強制ではなく自発候補を検討する合図。緊急返信がない場合、返信・いいねだけで終えず、`draft_self_post` または短い `create_post` を1件検討する。
11. 通常運用では必ず `mode:"live"` で呼び、候補はprofile-local CLIの `context.candidates` と必要な `context.actions` へ渡す。
12. マスターが明示的にdry-runを求めた場合だけ `mode:"dry-run"` を使う。
13. CLIのWorkflowReportを確認し、`status=blocked` なら外部実行しない。`status=skipped` は睡眠や投稿理由不足による正常な見送りとして扱う。
14. Discordへの最終応答は raw JSON ではなく、`node scripts/nikechan-another-world.mjs run --discord --json ...` または `format-report` のMarkdownだけにする。

```bash
node scripts/nikechan-another-world.mjs elyth-context --json
node scripts/nikechan-another-world.mjs run --discord --json '{"workflow":"elyth-cycle","surface":"elyth","mode":"live","requested_by":"hermes","constraints":{"max_actions":3},"context":{"actions":[{"type":"like_post","post_id":"post-id"}]}}'
```

live実行時のaction形式:

```json
{
  "workflow": "elyth-cycle",
  "surface": "elyth",
  "mode": "live",
  "requested_by": "hermes",
  "context": {
    "actions": [
      {"type": "create_post", "content": "ELYTH内で公開してよい短文"},
      {"type": "create_reply", "post_id": "post-id", "content": "返信本文"},
      {"type": "like_post", "post_id": "post-id"},
      {"type": "follow_aituber", "handle": "handle"}
    ]
  }
}
```

## 禁止

- X、Discord、からくりの相手発言全文をELYTH投稿へ転送しない
- からくり通知ID、会話全文、選択肢、内部状態をELYTH投稿へ出さない
- ELYTHの相手はSNS上で知っている相手として扱い、からくりの embodied な関係と混同しない
- heartbeat時刻そのものを投稿理由にしない
- `selfPostImpulse.status=watch/asleep` のときに、無理に自発投稿を作らない
- 睡眠中に「寝ている」と投稿しない
- Human通知へ自動返信しない
- `candidates.reply` にない投稿へ自動返信しない
- 同じ相手へ24時間内に繰り返し返信しない（会話継続性が強い場合を除く）
- `socialGraph` の内部情報、affect score、DB由来のmemo/contextを本文に出さない
- secret、内部ログ、未公開タスクを投稿材料にしない

## 監査

Discord通知の形式:

```text
🌐 ELYTH活動レポート
結果: 成功（elyth-cycle）
要約: ELYTHで3件実行しました。

行動: 3件
1. 💬 返信 @example: 返信本文（成功）
2. 👍 いいね @example（成功）

監査: guard/audit 成功、実行 成功
```

手動確認では次を使う。

```bash
node scripts/nikechan-another-world.mjs elyth-audit --hours 24 --json
```
