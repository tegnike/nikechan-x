# Bounded X memory backlog processing

2026-10-05. The normal 30-minute timer remains enabled. This dedicated worker processes existing X extraction and summary-embedding queues continuously, without source reconciliation or database schema/function changes. YouTube is excluded.

## Limits and checks

- Uses the existing X extraction rules, Codex OAuth adapter and configured model. No provider/model fallback.
- Uses the existing Gemini embedding model and existing X claim/publication/failure RPCs. Lease and input-hash checks remain intact; stale vectors are discarded.
- Default: two extraction requests and two embedding requests in parallel. Database RPCs within the worker are serialized. Separate normal-worker claims remain protected by existing database leases.
- At most 1,000 extraction claims and 10,000 embedding claims, with a 120-minute time budget. Extraction claims stop eight minutes before the deadline; embedding claims stop two minutes before it. In-flight jobs finish before exit.
- Known model failures, three consecutive extraction failures, or any embedding-batch failure stop new claims. Regular processing remains enabled to handle future work.
- Logs contain counters, elapsed time and safe failure codes only. No original text, credentials, leases, input hashes or source identifiers are logged.

Environment overrides: X_BACKFILL_EXTRACT_LIMIT, X_BACKFILL_EMBED_LIMIT, X_BACKFILL_EXTRACT_CONCURRENCY, X_BACKFILL_EMBED_CONCURRENCY, X_BACKFILL_MINUTES. Setting either item limit to 0 disables that stage.

## Validation

17 focused tests passed, including queue limits, source grouping, provider failure, stale publication, cancellation, deadline and RPC serialization. The production pilot finished in 48.153 seconds: eight summaries, four durable memories and 64 summary embeddings stored, zero failures/discards. The main run is separate; the pilot does not prove its completion.

## Run and inspect

Run scripts/x-memory-backfill.mjs inside the existing nikechan-x container with HERMES_HOME set to its X profile. Production runs use a transient systemd service, a host flock for dedicated backfill exclusion, RuntimeMaxSec=130min, and TimeoutStopSec=10min. ExecStop signals the dedicated Node process inside the container; the runner stops claiming and drains active jobs.

Main unit: nikechan-x-memory-backfill-20261005.service. Inspect with systemctl show and journalctl. A running unit is not proof of completion: require the finish event, zero fatal_code, and database queue readback.

Stop with systemctl stop nikechan-x-memory-backfill-20261005.service. The normal nikechan-x-memory.timer is independent and remains enabled. This worker does not post to X or Discord.
