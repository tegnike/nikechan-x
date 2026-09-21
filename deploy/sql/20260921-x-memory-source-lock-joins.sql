DO $migration$
DECLARE definition text; old_statement text;
BEGIN
 definition=pg_get_functiondef('public.memory_stage_x_batch_v1(jsonb)'::regprocedure);
 old_statement='PERFORM 1 FROM memory_sources s WHERE s.current_revision_id=ANY(all_ids) ORDER BY s.id FOR UPDATE;';
 IF position(old_statement in definition)=0 THEN RAISE EXCEPTION 'stage_lock_statement_changed'; END IF;
 definition=replace(definition,old_statement,'PERFORM 1 FROM memory_source_revisions r JOIN memory_sources s ON s.id=r.source_id AND s.current_revision_id=r.id WHERE r.id=ANY(all_ids) ORDER BY s.id FOR UPDATE OF s;');
 definition=replace(definition,'FROM memory_sources s WHERE s.current_revision_id=ANY(primary_ids);','FROM memory_source_revisions r JOIN memory_sources s ON s.id=r.source_id AND s.current_revision_id=r.id WHERE r.id=ANY(primary_ids);');
 EXECUTE definition;
 definition=pg_get_functiondef('public.memory_publish_x_batch_v1(uuid,text,uuid,jsonb,text,text)'::regprocedure);
 old_statement='PERFORM 1 FROM memory_sources s WHERE s.current_revision_id IN (SELECT revision_id FROM memory_x_batch_sources WHERE batch_id=segment.id) ORDER BY s.id FOR SHARE;';
 IF position(old_statement in definition)=0 THEN RAISE EXCEPTION 'publish_lock_statement_changed'; END IF;
 definition=replace(definition,old_statement,'PERFORM 1 FROM memory_x_batch_sources l JOIN memory_source_revisions r ON r.id=l.revision_id JOIN memory_sources s ON s.id=r.source_id AND s.current_revision_id=r.id WHERE l.batch_id=segment.id ORDER BY s.id FOR SHARE OF s;');
 EXECUTE definition;
END $migration$;
