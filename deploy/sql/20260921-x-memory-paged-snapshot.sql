-- Preserve the canonical snapshot eligibility/attribution expressions, changing
-- only pagination. The caller collects every page before grouping once.
DO $migration$
DECLARE definition text;
BEGIN
 definition=pg_get_functiondef('public.memory_x_source_snapshot_v1(timestamptz,integer)'::regprocedure);
 definition=replace(definition,'memory_x_source_snapshot_v1(p_since timestamp with time zone, p_limit integer DEFAULT 20000)',
 'memory_x_source_snapshot_page_v1(p_since timestamp with time zone, p_after text DEFAULT ''''::text, p_limit integer DEFAULT 500)');
 definition=replace(definition,'p_limit NOT BETWEEN 1 AND 20000','p_limit NOT BETWEEN 1 AND 500');
 definition=replace(definition,'AND s.occurred_at>=p_since','AND s.occurred_at>=p_since AND s.source_key>p_after');
 definition=replace(definition,'ORDER BY s.occurred_at,s.source_key LIMIT p_limit+1','ORDER BY s.source_key LIMIT p_limit');
 IF position('memory_x_source_snapshot_page_v1' in definition)=0 OR position('s.source_key>p_after' in definition)=0 THEN RAISE EXCEPTION 'snapshot_definition_changed'; END IF;
 EXECUTE definition;
END $migration$;
REVOKE ALL ON FUNCTION public.memory_x_source_snapshot_page_v1(timestamptz,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.memory_x_source_snapshot_page_v1(timestamptz,text,integer) TO service_role;
