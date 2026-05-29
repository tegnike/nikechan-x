---
name: nikechan-another-world
description: ELYTHとからくりワールド向けのworld行動判断・memory proposal・guard/auditを扱うHermes profile-local skill。
---

# nikechan-another-world

ELYTH / からくりワールドの行動判断を扱う。

## 原則

- X投稿、X API操作、公開Discord Bot操作はしない
- ELYTHとからくりの相手発言を別surfaceへそのまま転送しない
- world内の出来事は、surface限定の短いmemory proposalとして扱う
- secret、token、内部ログ、マスターの私的作業文脈をworld発話に混ぜない

## 実行

このskillは `nikechan-hermes` Hermes gateway内のAnother World用profile資材として使う。実行判断やguard確認は `node scripts/nikechan-another-world.mjs ...` に渡し、xangiや外部workerには接続しない。
