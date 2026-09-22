DO $patch$
DECLARE definition text;
BEGIN
 definition=pg_get_functiondef('public.memory_claim_x_batches_v1(integer)'::regprocedure);
 IF position('candidate record;' in definition)>0 THEN RETURN; END IF;
 IF position('FOR batch IN SELECT b.* FROM memory_x_batches b' in definition)=0 OR position('FOR UPDATE SKIP LOCKED LOOP' in definition)=0 THEN RAISE EXCEPTION 'claim_definition_changed'; END IF;
 definition=replace(definition,'DECLARE batch memory_x_batches;', 'DECLARE candidate record; batch memory_x_batches;');
 definition=replace(definition,'FOR batch IN SELECT b.* FROM memory_x_batches b','FOR candidate IN SELECT b.id FROM memory_x_batches b');
 definition=replace(definition,'FOR UPDATE SKIP LOCKED LOOP', $body$LOOP
 SELECT b.* INTO batch FROM memory_x_batches b
 WHERE b.id=candidate.id
 AND (b.status='pending' OR (b.status='processing' AND b.lease_until<now()))
 AND (b.next_extract_at IS NULL OR b.next_extract_at<=now())
 FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN CONTINUE; END IF;$body$);
 IF position('candidate.id' in definition)=0 OR position('THEN CONTINUE' in definition)=0 THEN RAISE EXCEPTION 'claim_patch_failed'; END IF;
 EXECUTE definition;
END $patch$;
