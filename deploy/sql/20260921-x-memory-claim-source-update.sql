DO $migration$
DECLARE definition text; old_statement text;
BEGIN
 definition=pg_get_functiondef('public.memory_claim_x_batches_v1(integer)'::regprocedure);
 old_statement='UPDATE memory_sources s SET lifecycle=''active'' WHERE s.lifecycle=''withheld'' AND s.current_revision_id IN (SELECT revision_id FROM memory_x_batch_sources WHERE batch_id=batch.id);';
 IF position(old_statement in definition)=0 THEN RAISE EXCEPTION 'claim_source_statement_changed'; END IF;
 definition=replace(definition,old_statement,
 'UPDATE memory_sources s SET lifecycle=''active'' FROM memory_x_batch_sources l JOIN memory_source_revisions r ON r.id=l.revision_id WHERE l.batch_id=batch.id AND s.id=r.source_id AND s.current_revision_id=r.id AND s.lifecycle=''withheld'';');
 EXECUTE definition;
END $migration$;
