-- Run outside a transaction. If a previous interrupted build left an invalid index, drop that index concurrently before retry.
SET statement_timeout='10min';
-- Avoid scanning all Discord keys before the first X page.
CREATE INDEX CONCURRENTLY IF NOT EXISTS memory_sources_x_keyset_idx
ON public.memory_sources(source_key) WHERE surface='twitter' AND lifecycle<>'deleted';
