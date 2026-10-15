DO LANGUAGE plpgsql $replay_isolation$
DECLARE body text; before_body text; changed integer:=0;
BEGIN
 body:=pg_get_functiondef('public.radar_cb_store_read(text,text,text)'::regprocedure); before_body:=body;
 IF position('historical_replay_step' IN body)=0 THEN
  IF position($old_store$WHERE ($1 IS NULL OR id=$1) AND ($2 IS NULL OR id COLLATE "C">$2 COLLATE "C")$old_store$ IN body)=0 OR position('INTO rows,total USING p_id,p_after;' IN body)=0 THEN RAISE EXCEPTION 'unexpected store function definition'; END IF;
  body:=replace(body,$old_store$WHERE ($1 IS NULL OR id=$1) AND ($2 IS NULL OR id COLLATE "C">$2 COLLATE "C")$old_store$,$new_store$WHERE ($1 IS NOT NULL OR $3<>''forecast_snapshots'' OR payload->>''recordType'' IS DISTINCT FROM ''historical_replay_step'') AND ($1 IS NULL OR id=$1) AND ($2 IS NULL OR id COLLATE "C">$2 COLLATE "C")$new_store$);
  body:=replace(body,'INTO rows,total USING p_id,p_after;','INTO rows,total USING p_id,p_after,p_table;');
  EXECUTE body; changed:=changed+1;
 END IF;
 body:=pg_get_functiondef('public.radar_cb_public_bundle(jsonb,text)'::regprocedure);
 IF position('historical_replay_step' IN body)=0 THEN
  IF position($old_legacy$WHERE view_name='legacy' OR id IN (SELECT c->>'snapshotId'$old_legacy$ IN body)=0 THEN RAISE EXCEPTION 'unexpected public function definition'; END IF;
  body:=replace(body,$old_legacy$WHERE view_name='legacy' OR id IN (SELECT c->>'snapshotId'$old_legacy$,$new_legacy$WHERE (view_name='legacy' AND payload->>'recordType' IS DISTINCT FROM 'historical_replay_step') OR id IN (SELECT c->>'snapshotId'$new_legacy$);
  EXECUTE body; changed:=changed+1;
 END IF;
END;
$replay_isolation$;
SELECT jsonb_build_object('readFilterInstalled',position('historical_replay_step' IN pg_get_functiondef('public.radar_cb_store_read(text,text,text)'::regprocedure))>0,'legacyFilterInstalled',position('historical_replay_step' IN pg_get_functiondef('public.radar_cb_public_bundle(jsonb,text)'::regprocedure))>0,'businessRowsUntouched',true) AS replay_read_isolation;
