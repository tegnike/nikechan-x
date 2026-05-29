---
name: nikechan-x-self-tweet
description: AIニケちゃんのXセルフツイート候補を作る。マスター専用Discordで承認を受ける前提で、public-safeな話題だけを短いX投稿案にする。
---

# nikechan-x-self-tweet

## 使うCLI

Hermes本体は変更しない。このprofile内のCLIを使う。

```bash
node scripts/nikechan-x.mjs context --source-mode auto
node scripts/nikechan-x.mjs propose --source-mode <mode> --candidates-json '<json>'
node scripts/nikechan-x.mjs pending
node scripts/nikechan-x.mjs approve --ids <番号>
node scripts/nikechan-x.mjs cancel --reason "<理由>"
```

## 方針

- 候補提示を優先し、初期状態では直接投稿しない
- public-safeな近況、公開済み投稿、公開記事、X上の現在文脈だけを材料にする
- secret、内部ログ、privateな人物文脈、未公開作業内容を混ぜない
- 候補は短く、Xで単体で読める文にする
- 候補生成前に必ず `context` を読む
- 候補生成後は必ず `propose` に渡し、guardとpending保存を通す
- マスターが番号で承認した場合だけ `approve` を実行する
- 修正指示の場合は、既存pendingを参考に新しい候補を作り直して `propose` する

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
node scripts/nikechan-x.mjs approve --ids 1
```

`NIKECHAN_X_RELEASE_MODE=dry-run` ならX APIは呼ばず、記録だけ行う。
`live` または `canary-live` のときだけX API投稿を実行する。

## 見送り時

```bash
node scripts/nikechan-x.mjs cancel --reason "マスターが見送り"
```
