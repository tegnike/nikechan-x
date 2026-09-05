# X storage recovery (2026-09-05)

Posting still uses the existing X workflow. This change needs no schema migration or extra X fetch.

- `recordTweet` queues the successful provider result under `state/storage-outbox/<uuid>.json` before attempting Supabase. The stored row UUID and provider tweet ID stay unchanged on retry. `tweets.created_at` records the result receipt time; it is not a provider-authenticated `posted_at`.
- `recordActivity` uses the same outbox. Execution status is now `parsed.activity_status`; the nonexistent top-level `status` column is no longer sent. Existing parsed keys and the local activity JSONL remain available.
- Files are created with mode 0600, fsynced, and renamed. Successful DB writes remove their files. DB failure retains files and reports pending counts. A storage failure never asks the caller to repost.
- The normal recording path drains up to 25 records, stopping on a DB failure. A DB-only manual drain is `node scripts/nikechan-x.mjs retry-storage`. It loads Supabase settings and never invokes X, Discord, or a model. Check `pending` in the result; a nonzero count requires another drain or investigation. This command does not add any timer.
- Retries use `on_conflict=id` and `resolution=ignore-duplicates` against existing UUID primary keys, so a lost DB response does not duplicate the row. Concurrent drains have the same property.

Validation: `unshare -n node --test test/storage-outbox.test.mjs` runs six tests with external networking unavailable; the CLI integration supplies a fake X response then fails DB writes, and verifies DB-only recovery. Existing tests have four approval-flow failures reproduced on the unchanged baseline; this patch does not change their policy.

Limits: this is not a transaction spanning X and local disk. A process crash after X success but before the local result is persisted, or loss of the host disk, still needs investigation; do not blindly replay a post. New outbox files do not backfill historical missing records. `contact_episodes`, counters and `twitter_run_state` retain their existing separate persistence behavior. No production test post or paid API request is needed to validate this change.
