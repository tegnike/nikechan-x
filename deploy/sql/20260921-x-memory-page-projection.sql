-- Force the keyset page to be selected before per-row direct-interaction work.
DO $migration$
DECLARE definition text;
BEGIN
 definition=pg_get_functiondef('public.memory_x_source_snapshot_page_v1(timestamptz,text,integer)'::regprocedure);
 definition=replace(definition,'FROM memory_sources s JOIN memory_source_revisions r ON r.id=s.current_revision_id',
 'FROM (SELECT s0.* FROM memory_sources s0 JOIN memory_source_revisions r0 ON r0.id=s0.current_revision_id WHERE s0.surface=''twitter'' AND s0.lifecycle<>''deleted'' AND s0.occurred_at>=p_since AND s0.source_key>p_after ORDER BY s0.source_key LIMIT p_limit) s JOIN memory_source_revisions r ON r.id=s.current_revision_id');
 IF position('SELECT s0.*' in definition)=0 THEN RAISE EXCEPTION 'snapshot_page_definition_changed'; END IF;
 EXECUTE definition;
END $migration$;
