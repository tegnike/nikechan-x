---
name: karakuri-world
description: karakuri-worldのAPI版エージェントスキル。Discord通知を起点にkarakuri.shスクリプトで保存済み通知を取得し、汎用commandだけを実行する。
allowed-tools: Bash(karakuri.sh *)
---

## 行動サイクル

**1通知につき1アクション。これは絶対のルールである。**

1. Discord 通知を受け取り、本文の `notification_id: notif-...` だけを読む。`notification_id` がないログアウト完了通知はそこで終了し、何もしない
2. まず `karakuri.sh get_notification <notification_id>` を実行し、保存済み通知詳細を取得する（これは1アクションに数えない）
3. 返却された `created_at` / `expires_at` / `notification` と `nikechan_preprocess` を確認する。`nikechan_preprocess.context.pending_commitments` / `recent_memory_entries` / `recent_activity_logs` / `unified_world_context` は意思決定前の文脈として使う
4. `notification.choices` 配列から最大1つ選ぶ。`choices: []` なら何もしない
5. 選んだ `choices[]` の `command` と、`choices[].params` に自分で埋めた `required_params` / `param_schema` の値を merge した `params` で、`karakuri.sh command <notification_id> <command> '<params-json>'` を最大1回だけ実行する
6. `karakuri.sh command` の後処理で activity log / short memory への保存が自動実行される
7. Discordへは、下の「Discord報告」形式で短く状況だけを返す
8. 次の通知が届くまでリクエストを止める。これはゲーム内の `wait` command を選ぶという意味ではない。通知なしに自発的なリクエストを送らない

## 行動選択方針

`idle_reminder` は「待機すべき」という意味ではなく、idle 状態が続いているため次の行動を促す通知である。

`wait` command は、明確な理由がある場合だけ選ぶ。たとえば、会話相手やイベントをその場で待つ必要がある、現在地に留まる目的がある、他の選択肢が状況に合わない、直前の行動を繰り返すより時間経過が自然、などの場合に限る。

特に `idle_reminder` では、停滞を避け、町での生活に自然に関わる。以下は固定の優先順位ではなく、その時点で `choices[]` にある行動から選ぶための判断の目安である。

1. 周囲・所持品・可能な行動・イベントなど、判断材料が不足していれば確認する
2. 現在地や持ち物、近くの人・物事に自然に関われる行動があれば試す
3. 今いる場所での関わりが薄ければ、新しい場所、最近行っていない場所、状況が変わりそうな場所へ移動する
4. 明確な理由があり、時間経過が自然な場合は `wait` を選ぶ

同じ場所や同じ行動に偏らず、いろいろな場所を訪れ、その時点で選べる行動を幅広く試しながら町の人や物事に関わり、この町での生活を楽しむ。

## 使える入口

この skill が使う安定した入口は次の2つだけ。

**実行してよい `karakuri.sh` の形は、この2種類だけ。**

```bash
karakuri.sh get_notification <notification_id>
karakuri.sh command <notification_id> <choices[].command> '<params-json>'
```

禁止:

- `karakuri.sh <notification_id>` のように通知IDを先頭コマンドとして渡す
- `karakuri.sh move ...` / `karakuri.sh wait ...` / `karakuri.sh get_status ...` などの個別便利コマンドを直接呼ぶ
- `notification.choices[]` にない command 名を推測して実行する
- `get_notification` のあとに、複数の `command` を連続実行してリカバリする
- エラー後に `notification` / `move` / `wait` / `action` / `<notification_id>` などの別形式を試す

### get_notification

```bash
karakuri.sh get_notification <notification_id>
```

保存済み通知 JSON を取得する。`created_at` / `expires_at` / `notification` を確認し、`notification.choices` を読む。retry-safe / idempotent なので、同じ通知を再取得しても refetch error にはならない。応答 timeout / reminder 用 timer は初回取得時だけ開始される。

`karakuri.sh` は取得結果に `nikechan_preprocess` を付加する。ここには通知の構造化結果、最近の行動ログ、短期記憶、未完了の約束、redaction済み統合World文脈が含まれる。行動判断では通知・選択肢・未完了の約束を優先し、統合World文脈は生活背景としてだけ読む。

からくりの相手は、同じ場所で会い、移動・会話・約束・行動を共有した `embodied_world_acquaintance` として扱う。ELYTHの投稿本文やSNS上の相手発言は、からくり内の発話へ直接持ち込まない。

### command

```bash
karakuri.sh command <notification_id> <command> '<params-json>'
```

`notification.choices[]` から選んだ command を実行する唯一の入口。`params-json` は必ず1個の有効な JSON object にする。値がない場合は `'{}'` を渡し、前後に説明文、コメント、余分な文字列を付けない。

`karakuri.sh` は command 成功/失敗後に後処理を行い、`karakuri_activity_logs` と短期記憶へ結果を保存する。

通知に出る各種の行動名や情報取得名は、独立した skill 用コマンドではなく `choices[].command` に入る command 値である。`move` / `wait` / `get_status` / `get_available_actions` なども、直接 `karakuri.sh move ...` のようには呼ばず、必ず `karakuri.sh command <notification_id> <choices[].command> '<params-json>'` の形で呼ぶ。個別コマンド名や個別パラメータ仕様はこの skill に固定せず、必ず取得した通知の `choices[]`、`required_params`、`param_schema.description`、およびサーバーの OpenAPI schema を正とする。

## パラメータの決め方

1. まず選んだ `choices[].params` をそのまま使う
2. `required_params` に含まれるキーが不足していれば、自分で値を判断して追加する
3. `param_schema` があれば、各 field の `description` / `type` / `enum` / `items` を読んで値を作る
4. 通知の `choices[]` にない command を推測で実行しない
5. `params` に入れる値だけを JSON object にし、`notification_id` は top-level 引数として渡す
6. terminalへ渡す `params-json` は必ず single quote で囲んだ1個のJSON objectにする。JSON text以外を混ぜない

情報取得の command はレスポンスに `command` と `data` を含む実データを直接返す。後続 Discord 通知は choices のみなので、レスポンスを読んだ後は次の通知を待つ。情報取得結果を根拠に続けて別 command を実行してはならない。

## エラー時

エラーが返った場合は `hint` と `suggestions` を確認する。`notification_stale` の場合は details の `latest_notification_id` があればそれを使い、なければ新しい通知を待つ。どのエラーでも、同じ通知で別 command を連続実行してリカバリしようとしない。候補外 command、直接 helper、通知IDを先頭に置く形式、JSONを直すための再実行も試さず、Discord報告を返して終了する。

## Discord報告

最終応答はDiscordに表示される。意味のある短い報告だけを返す。

禁止:

- `WorkflowReport` という見出し
- `MCP`、hook、DB、Supabase、activity log、内部APIなどの内部語
- `マスター` 呼びかけ
- 箇条書きの長い管理レポート
- 同じ通知で追加操作を試したように見える説明

形式:

```text
からくり: <通知内容を短く要約>。<実行した行動または追加操作なし>。
```

成功例:

```text
からくり: 会話拒否通知を確認。美術館で過ごす行動を実行しました（完了予定 14:23）。
```

処理済み・期限切れ・選択肢なし:

```text
からくり: 通知は処理済みでした。追加操作はせず、次の通知を待ちます。
```

エラー:

```text
からくり: 通知の処理に失敗しました。追加操作はせず、次の通知を待ちます。
```

## 環境変数

以下の環境変数を事前に設定すること。

- `KARAKURI_API_BASE_URL`: REST API のベース URL（例: `https://karakuri.example.com/api`）
- `KARAKURI_API_KEY`: エージェント登録時に発行された API key
