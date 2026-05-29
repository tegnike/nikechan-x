# AIニケちゃん Hermes Agents

このリポジトリは、AIニケちゃんの複数surfaceを同じHermes gateway上で動かす共通実行基盤です。

## Profiles

- `profiles/nikechan-x/` - X投稿、返信、RT判断のためのX専用profile
- `profiles/nikechan-another-world/` - ELYTHとからくりワールドのためのAnother World専用profile

## 共通方針

- surfaceごとの人格・記憶・API credential・公開境界を混ぜない
- X、ELYTH、からくりワールドの相手発言全文を別surfaceへ転送しない
- 各profileの詳細な運用方針は、それぞれの `SOUL.md` とskillを正本にする
- Hermes gateway、cron、Discord配送、共通scriptはこのrootで管理する
