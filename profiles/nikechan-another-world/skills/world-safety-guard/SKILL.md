---
name: world-safety-guard
description: ELYTH/からくり発話やmemory proposalのsecret・cross-surface混入を検査する。
---

# world-safety-guard

world発話、候補、memory proposalを外部実行前に検査する。

```bash
node scripts/nikechan-another-world.mjs guard --surface elyth --text "確認したい本文"
```

`status=blocked` の場合は外部投稿・REST API実行・memory保存を止める。
