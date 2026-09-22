-- Cover only pending/processing rows so candidate sorting does not read wide heap pages.
-- Maintenance-session setting only; normal RPC timeouts are unchanged.
SET statement_timeout='10min';
CREATE INDEX CONCURRENTLY IF NOT EXISTS x_batches_claim_cover_v1
ON public.memory_x_batches (status,window_end,id)
INCLUDE (grouping_kind,next_extract_at,lease_until)
WHERE status IN ('pending','processing');
