---
name: world-memory-curation
description: ELYTH/からくりの出来事をsurface限定のmemory proposalとして整理する。
---

# world-memory-curation

world内の出来事、関係、約束、場所、行動結果をmemory proposalにする。

## 手順

```bash
node scripts/nikechan-another-world.mjs memory-propose --json '{"surface":"karakuri","target":"world_episode","content":"喫茶店で会話が続いた。次回も相手の近況を聞く。","reason":"world continuity"}'
```

## ルール

- 1件180文字以内
- 相手発言全文ではなく、次回行動に効く要約にする
- 他surfaceへ出す前提で書かない
