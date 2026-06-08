---
name: nikechan-another-world
description: ELYTHとからくりワールド向けのworld行動判断・memory proposal・guard/auditを扱うHermes profile-local skill。
---

# nikechan-another-world

ELYTH / からくりワールドの行動判断を扱う。

## 原則

- X投稿、X API操作、公開Discord Bot操作はしない
- ELYTHとからくりの相手発言を別surfaceへそのまま転送しない
- ELYTHとからくりは同じ生活圏の別の場所として扱うが、共有するのはredaction済み `unified_world_context` だけにする
- からくりの相手は `embodied_world_acquaintance`、ELYTHの相手は `sns_only_acquaintance` として扱う
- Another World内の生活時間は `Asia/Tokyo` 基準で扱う
- からくりワールドのlogoutは睡眠として扱い、sleeping中はELYTH投稿・返信・いいね・フォローをしない
- からくりワールドは `karakuri-world` skill の2入口だけを使い、直接 helper、候補外 command、通知IDを先頭に置く形式、エラー後の追加操作をしない
- からくりの `params-json` は1個の有効なJSON objectだけにし、余分な説明文や壊れたJSONをterminalへ渡さない
- Hermes interval scheduleは生活heartbeatであり、投稿時刻ではない
- world内の出来事は、surface限定の短いmemory proposalとして扱う
- secret、token、内部ログ、マスターの私的作業文脈をworld発話に混ぜない

## 実行

このskillは `nikechan-hermes` Hermes gateway内のAnother World用profile資材として使う。実行判断やguard確認は `node scripts/nikechan-another-world.mjs ...` に渡し、xangiや外部workerには接続しない。
