DO $migration$
DECLARE definition text;
BEGIN
 definition=pg_get_functiondef('public.memory_claim_x_batches_v1(integer)'::regprocedure);
 definition=replace(definition,' AND NOT EXISTS(SELECT FROM memory_x_batch_sources l WHERE l.batch_id=b.id AND NOT memory_x_revision_eligible_v1(l.revision_id))','');
 definition=replace(definition,'LIMIT least(greatest(p_limit,1),1) FOR UPDATE SKIP LOCKED LOOP','FOR UPDATE SKIP LOCKED LOOP');
 definition=replace(definition,' token=gen_random_uuid();',' IF EXISTS(SELECT FROM memory_x_batch_sources l WHERE l.batch_id=batch.id AND NOT memory_x_revision_eligible_v1(l.revision_id)) THEN CONTINUE; END IF;'||chr(10)||' token=gen_random_uuid();');
 definition=replace(definition,'''prior_items'',prior));','''prior_items'',prior));'||chr(10)||' EXIT;');
 IF position('l.batch_id=b.id' in definition)>0 OR position('THEN CONTINUE' in definition)=0 OR position(' EXIT;' in definition)=0 THEN RAISE EXCEPTION 'claim_definition_changed'; END IF;
 EXECUTE definition;
END $migration$;
