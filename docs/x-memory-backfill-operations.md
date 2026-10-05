# Bounded X memory backlog processing

2026-10-05. The normal 30-minute timer remains enabled. This dedicated worker processes existing X extraction and summary-embedding queues continuously, without source reconciliation or database schema/function changes. YouTube is excluded.

## Limits and checks

- Uses the existing X extraction rules, Codex OAuth adapter and configured model. No provider/model fallback.
- Uses the existing Gemini embedding model and existing X claim/publication/failure RPCs. Lease and input-hash checks remain intact; stale vectors are discarded.
- Default: two extraction requests and two embedding requests in parallel. Database RPCs within the worker are serialized. Separate normal-worker claims remain protected by existing database leases.
- At most 1,000 extraction claims and 10,000 embedding claims, with a 120-minute time budget. Extraction claims stop eight minutes before the deadline; embedding claims stop two minutes before it. In-flight jobs finish before exit.
- Embedding provider HTTP 408/5xx and known transport timeouts/resets retry at most twice (2s/4s). Invalid input, auth and rate-limit failures do not retry automatically. Publication RPCs are never retried by this wrapper.
- Known model failures, three consecutive extraction failures, or any embedding-batch failure stop new claims. Regular processing remains enabled to handle future work.
- Logs contain counters, elapsed time and safe failure codes only. No original text, credentials, leases, input hashes or source identifiers are logged.

Environment overrides: X_BACKFILL_EXTRACT_LIMIT, X_BACKFILL_EMBED_LIMIT, X_BACKFILL_EXTRACT_CONCURRENCY, X_BACKFILL_EMBED_CONCURRENCY, X_BACKFILL_MINUTES. Setting either item limit to 0 disables that stage.

## Validation

17 focused tests passed, including queue limits, source grouping, provider failure, stale publication, cancellation, deadline and RPC serialization. The production pilot finished in 48.153 seconds: eight summaries, four durable memories and 64 summary embeddings stored, zero failures/discards. The main run is separate; the pilot does not prove its completion.

## Run and inspect

Run scripts/x-memory-backfill.mjs inside the existing nikechan-x container with HERMES_HOME set to its X profile. Production runs use a transient systemd service, a host flock for dedicated backfill exclusion, RuntimeMaxSec=130min, and TimeoutStopSec=10min. ExecStop signals the dedicated Node process inside the container; the runner stops claiming and drains active jobs.

Main unit: nikechan-x-memory-backfill-20261005.service. Inspect with systemctl show and journalctl. A running unit is not proof of completion: require the finish event, zero fatal_code, and database queue readback.

Stop with systemctl stop nikechan-x-memory-backfill-20261005.service. The normal nikechan-x-memory.timer is independent and remains enabled. This worker does not post to X or Discord.

## First-run interruption and resume

The first main run stored 160 summaries, 92 durable memories and 1,695 summary vectors before one embedding failure stopped it at 16:46 Europe/Warsaw. The failed summary embedded successfully in a read-only diagnostic probe; the original failure was logged generically, so its exact provider/publication cause is unknown. Phase and safe HTTP-status diagnostics were added together with bounded transient-provider retries. Existing data and failed-job retry schedules are preserved; no direct queue reset is performed.

## Request-rate handling

The resumed single-input run stored another 181 summaries, 83 durable memories and 1,863 vectors before a provider HTTP 429 at 17:10 Europe/Warsaw. A provider HTTP 503 earlier in that run recovered via the bounded retry wrapper.

The dedicated runner now sends up to eight summaries in one synchronous batchEmbedContents request, using the same embedding model/task/dimension. Returned vector count and dimensions are checked before publication, and input order maps to the original leases/hashes. A two-input synthetic API probe returned HTTP 200 with two 768-dimensional vectors. Only whole-batch requests opt into 429 cooldown (60s then 120s, at most two retries). Invalid input/auth errors and exhausted retries still stop new work. Original data and database functions are unchanged.

Provider request ordering and method: https://ai.google.dev/api/embeddings . The second pilot/main completion must be checked independently of the earlier single-input pilot. Status polling now uses stable id order to prevent updates from moving rows between offset pages.

Grouped-request pilot: 64 summary vectors stored in 32.654 seconds, zero failures/discards. Current main unit is nikechan-x-memory-backfill-grouped-20261005.service. Tests: 26 focused checks passed.
