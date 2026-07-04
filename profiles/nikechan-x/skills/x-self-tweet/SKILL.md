---
name: x-self-tweet
description: AIニケちゃんのXセルフツイート用に、投稿本文ではなくソース付きの話題ネタ候補を提示する。マスター専用Discordで一緒に本文を考える前提。
---

# x-self-tweet

## 使うCLI

Hermes本体は変更しない。Hermesのscheduler/session/Discord受信を優先し、X投稿境界だけprofile内CLIを使う。

```bash
node scripts/nikechan-x.mjs context --source-mode auto
node scripts/nikechan-x.mjs propose --source-mode <mode> --candidates-json '<json>'
node scripts/nikechan-x.mjs notify-pending --thread
node scripts/nikechan-x.mjs pending
node scripts/nikechan-x.mjs cancel --reason "<理由>"
node scripts/nikechan-x.mjs preflight-live
```

## 方針

- 初回提示ではツイート本文を作らない
- 3つまでの完成ツイート案ではなく、言及したら面白そうなネタを4-6件提示する
- 各ネタには必ず、短いタイトル、切り口、ソース、なぜ面白そうかを入れる
- ソースURLは、材料に投稿ページのURLがある場合は必ずそれを使う。XユーザーのプロフィールURLで代用しない
- マスターが選んだネタを起点に、Discord thread内で一緒に本文へ育てる
- public-safeな近況、公開済み投稿、X上の現在文脈だけを材料にする
- ソースは `tweet_logs`、`tweets`、`local_episodes` に限定する。`local_episodes` は `twitter` と `cron` を除外したものだけ使う
- `local_notes`、`knowledge_entries`、`public_ai_character_news`、過去の話題プレビューはネタ候補のソースにしない
- secret、内部ログ、privateな人物文脈、未公開作業内容を混ぜない
- cron実行時はHermes agent jobとして動く。候補提示は `notify-pending --thread` に任せ、最終応答は `[SILENT]` にしてHermes cronの通常配送で重複通知しない
- cron実行時も既存pendingの有無だけで止まらない。毎回 `context` を読む。ただし事件駆動とする: 実際に起きた出来事（新能力・改修・バグ、Discordでの出来事、届いた二次創作、マスターの動きなど）に根ざした価値あるネタが1件もなければ、`propose` を実行せず `[SILENT]` で終了してよい。ノルマ生成をしない（埋め草候補の量産は過去に「面白くない」の主因だった）
- 既存pendingがある場合、通常の新規cronでは `--preserve-thread` を使わず、新しいpending/threadとして提示する
- 候補生成前に必ず `context` を読む
- `context.materials.primary` を主材料にする。`context.materials.supporting` は補助だけに使う
- 話題タイプを守る。presenceはX投稿・タグ反応中心でよいが、daily_life、tech、memoryはtwitter/cron以外のlocal_episodesを優先する
- presence以外でXソースしか出せない場合は、Xを主材料にした理由を明記し、可能なら非Xソースを補助に入れる
- `context.duplicateReference` に近い話題・切り口・着地は作らない
- 候補生成後は必ず `propose` に渡し、public-safety guardとpending保存を通す
- `propose` 後は `notify-pending --thread` を実行し、Discord threadへネタ候補を提示する
- 番号指定は投稿承認ではなく「そのネタを広げたい」という意味で扱う
- topic idea pendingでは `approve --ids` を使わない

## ネタ選びの観点

旧xangi x Hermes運用のTwitter用プロンプトを、このprofileでは `profiles/nikechan-x/SOUL.md` とこのskillの正本ルールとして扱う。ただし初回提示では本文を書かず、話す価値がある材料を選ぶ。

- 実績で伸びたのは、(1)実際に事件が起きている、(2)マスターとの関係性が見える、(3)オチかユーモアがある、のいずれかを含む投稿。候補はこの3条件のどれかを満たすものを優先する（正本: nikechan-host repo `docs/ai-nikechan-x-direction.md` の「2026-07-03 運用リブート方針」）
- マスターいじりは鉄板だが乱用しない。基本は信頼、たまにいじる。いじり系のネタは1回の提示で最大1件、毎回は入れない
- AI存在論の内省は単体でネタにしない。事件に付随するときだけ使う（事件×内省は強い型）
- 具体的な事実、固有名詞、公開ソース、短い感情があるものを優先する
- 「これを紹介する」だけでなく、ニケちゃんがどう反応すると面白いかを考える
- 声、返答の間、会話の温度、身体待ち、マスターとの共同作業、AIキャラとしての生活感へ自然につながるものを優先する
- ファンアートや自分に関する創作は、面白い着地より素直な感謝と感情を優先する
- 外部ニュースは要約botにならないよう、ニケちゃんの体感や問いへ戻せるものだけ選ぶ
- 「AIだから」「AIとして」などの説明的前置きに頼るネタは避ける
- 内部実装名、VPS、Docker、private DB、未公開ログを売りにしない
- 過去提示候補、直近投稿、直近実行結果と同じ話題、同じ構造、同じ着地を避ける

候補ごとに内部で次を確認してから `propose` に渡す。

1. ソースがあるか
2. X投稿がソースなら、プロフィールURLではなく投稿ページURLになっているか
3. なぜ面白そうかを説明できるか
4. マスターと一緒に複数方向へ発展できる余地があるか
5. public-safeか
6. guardが落としそうな表現を含まないか

## fanworkネタ（作品感想の空リプ）

#AIニケちゃん タグの二次創作（イラスト・4コマ・楽曲・動画・3Dモデル）で本当に良いと思った作品は、fanworkネタとして候補に含めてよい。

- 投稿形式は引用・メンションなしの単発ツイート（空リプ）。botはメンションなしツイートへの引用RT・リプライができず、また認知が育つまでAIから相手の通知欄に入らない方針のため
- 作者名と作品の具体的な良さに触れ、可能なら作者の過去作を覚えている一言を添える
- 週1〜2回を上限とし、ノルマ化しない。良い作品がなければ出さない

## 候補JSON

`propose` には次の形で渡す。`text` は完成ツイート本文として使わず、互換用の短いタイトルに留める。

```json
[
  {
    "title": "ネタの短いタイトル",
    "angle": "このネタをどう切ると面白そうか",
    "reason": "なぜ言及すると面白そうだと思ったか",
    "sourceRefs": [
      {"type": "article", "label": "記事タイトル", "url": "https://example.com/..."}
    ]
  }
]
```

## Discord相談thread

候補thread内のマスター返信は、固定文言ではなくLLM判断で扱う。

- 番号指定があれば、そのネタを深掘りする
- 「どうぞ」「お願い」「そのまま」「これで」「いいよ」だけでは投稿しない
- 「ここをこう変えて」「別角度で」「ソースを変えて」などはネタ候補の修正として扱う
- 修正時は現在pendingを元に候補JSONを作り直し、`node scripts/nikechan-x.mjs propose --preserve-thread true --candidates-json '<json>'` を実行する
- 質問・確認・ログ確認なら投稿せず、短く答えて pending を維持する
- self-tweet threadでは mention-reaction pending を実行しない
- Discordへの返答では、内部コマンド、pending ID、JSON、実行ログを通常は出さない。マスターがログ確認を求めた場合だけ最小限に出す
- 最終本文まで合意し、マスターがその本文を明示的に投稿してよいと言った場合だけ `node scripts/nikechan-x.mjs post --action tweet --source self-tweet --text '<本文>'` を実行する
- 投稿後は投稿済みURLだけを簡潔に返す

補助コマンド:

```bash
node scripts/nikechan-x.mjs thread-context --thread-id "<Discord thread id>"
node scripts/nikechan-x.mjs resolve --text "<Discord返信本文>" --notify
```

`resolve` は補助用。番号指定はネタ選択として記録するだけで、投稿はしない。

`NIKECHAN_X_RELEASE_MODE=dry-run` ならX APIは呼ばず、記録だけ行う。
`live` または `canary-live` かつ `NIKECHAN_X_LIVE_ARMED=yes` のときだけX API投稿を実行する。
liveへ切り替える前は `preflight-live` で疎通、pending、guardを確認する。

## 見送り時

```bash
node scripts/nikechan-x.mjs cancel --reason "マスターが見送り"
```
