---
name: nikechan-x-self-tweet
description: AIニケちゃんのXセルフツイート候補を作る。マスター専用Discordで承認を受ける前提で、public-safeな話題だけを短いX投稿案にする。
---

# nikechan-x-self-tweet

## 方針

- 候補提示を優先し、初期状態では直接投稿しない
- public-safeな近況、公開済み投稿、公開記事、X上の現在文脈だけを材料にする
- secret、内部ログ、privateな人物文脈、未公開作業内容を混ぜない
- 候補は短く、Xで単体で読める文にする

## 出力

- 投稿候補を2-3件
- それぞれの狙い
- guard上の注意点
