-- Candidate only: apply to an isolated database after the existing business
-- and BetterAuth migrations. This does not create tables or grant access.
-- One DO statement also works with CloudBase's single-statement SQL editor.
DO LANGUAGE plpgsql $install$
BEGIN
EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.radar_cb_auth_snapshot()
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog SET timezone = 'UTC'
AS $fn$
DECLARE records jsonb;
BEGIN
  IF (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'backend role required' USING ERRCODE = '42501';
  END IF;
  LOCK TABLE public."user", public.account, public.session, public.verification IN SHARE MODE;
  IF (SELECT count(*) FROM public."user") + (SELECT count(*) FROM public.account)
     + (SELECT count(*) FROM public.session) + (SELECT count(*) FROM public.verification) > 1000 THEN
    RAISE EXCEPTION 'owner authentication snapshot limit exceeded' USING ERRCODE = '54000';
  END IF;
  records := jsonb_build_object(
    'user', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb) FROM public."user" t),
    'account', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb) FROM public.account t),
    'session', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb) FROM public.session t),
    'verification', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb) FROM public.verification t)
  );
  RETURN jsonb_build_object('fingerprint',md5(records::text),'records',records);
END
$fn$;
$ddl$;
EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.radar_cb_auth_commit(p_expected_fingerprint text, p_changes jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog SET timezone = 'UTC'
AS $fn$
DECLARE change jsonb; model text; kind text; row_id text; data jsonb;
        assignments text; column_list text; select_list text; affected integer;
BEGIN
  IF (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'backend role required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_changes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_changes)>1000 THEN
    RAISE EXCEPTION 'invalid authentication change set' USING ERRCODE = '22023';
  END IF;
  -- Prevent native writers too; snapshots cannot be silently overwritten.
  LOCK TABLE public."user", public.account, public.session, public.verification IN SHARE ROW EXCLUSIVE MODE;
  IF (public.radar_cb_auth_snapshot()->>'fingerprint') IS DISTINCT FROM p_expected_fingerprint THEN
    RAISE EXCEPTION 'authentication snapshot changed' USING ERRCODE = '40001';
  END IF;
  FOR change IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
    model:=change->>'model'; kind:=change->>'kind'; row_id:=change->>'id'; data:=change->'data';
    IF model IS NULL OR model NOT IN ('user','account','session','verification') OR row_id IS NULL OR row_id='' OR kind IS NULL OR kind NOT IN ('insert','update','delete') THEN
      RAISE EXCEPTION 'invalid authentication operation' USING ERRCODE = '22023';
    END IF;
    IF kind='delete' THEN
      EXECUTE format('DELETE FROM public.%I WHERE id=$1',model) USING row_id;
    ELSE
      IF jsonb_typeof(data) IS DISTINCT FROM 'object' OR (data->>'id') IS DISTINCT FROM row_id THEN
        RAISE EXCEPTION 'invalid authentication record' USING ERRCODE = '22023';
      END IF;
      IF EXISTS(SELECT 1 FROM jsonb_object_keys(data) AS f(name) WHERE NOT EXISTS(
          SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(format('public.%I',model)) AND a.attname=f.name AND a.attnum>0 AND NOT a.attisdropped)) THEN
        RAISE EXCEPTION 'unknown authentication field' USING ERRCODE = '22023';
      END IF;
      SELECT string_agg(format('%I=r.%I',a.attname,a.attname),',' ORDER BY a.attnum),
             string_agg(format('%I',a.attname),',' ORDER BY a.attnum),
             string_agg(format('r.%I',a.attname),',' ORDER BY a.attnum)
      INTO assignments,column_list,select_list FROM pg_attribute a
      WHERE a.attrelid=to_regclass(format('public.%I',model)) AND a.attnum>0 AND NOT a.attisdropped AND a.attname<>'id';
      IF kind='insert' THEN
        EXECUTE format('INSERT INTO public.%I(id,%s) SELECT r.id,%s FROM jsonb_populate_record(NULL::public.%I,$1) r',model,column_list,select_list,model) USING data;
      ELSE
        EXECUTE format('UPDATE public.%I t SET %s FROM jsonb_populate_record(NULL::public.%I,$1) r WHERE t.id=$2',model,assignments,model) USING data,row_id;
      END IF;
    END IF;
    GET DIAGNOSTICS affected=ROW_COUNT;
    IF affected<>1 THEN RAISE EXCEPTION 'authentication record changed' USING ERRCODE='40001'; END IF;
  END LOOP;
  -- Do not commit a state which the bounded owner adapter could not read back.
  PERFORM public.radar_cb_auth_snapshot();
  RETURN true;
END
$fn$;
$ddl$;
EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.radar_cb_claim_job()
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog SET timezone = 'UTC'
AS $fn$
DECLARE current_job jsonb; job_id text; claimed jsonb;
BEGIN
  IF (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'backend role required' USING ERRCODE = '42501';
  END IF;
  SELECT id,payload INTO job_id,current_job FROM public.radar_jobs
    WHERE (payload->>'status'='queued' AND (payload->>'availableAt')::timestamptz<=now())
       OR (payload->>'status'='running' AND (payload->>'leaseUntil')::timestamptz<now())
    ORDER BY CASE WHEN payload->>'status'='running' THEN 0 WHEN payload->>'kind'='collect' THEN 1
      WHEN payload->>'kind'='generate' AND coalesce(payload#>>'{payload,historical}','false')<>'true' THEN 2
      WHEN payload->>'kind'='generate' THEN 3 ELSE 4 END,
      CASE WHEN payload->>'kind'='generate' THEN payload#>>'{payload,evidencePublishedAt}' END DESC NULLS LAST,
      created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1;
  IF job_id IS NULL THEN RETURN NULL; END IF;
  claimed:=current_job || jsonb_build_object('status','running','attempts',(current_job->>'attempts')::integer+1,
    'leaseUntil',to_char(clock_timestamp()+interval '120 seconds','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  UPDATE public.radar_jobs SET payload=claimed WHERE id=job_id;
  RETURN claimed;
END
$fn$;
$ddl$;
EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.radar_cb_finish_job(p_id text,p_lease_until text,p_attempts integer,p_result jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog SET timezone = 'UTC'
AS $fn$
DECLARE current_job jsonb;
BEGIN
  IF (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'backend role required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR p_result->>'status' IS NULL OR p_result->>'status' NOT IN ('queued','succeeded','failed')
    OR jsonb_typeof(p_result->'payload') IS DISTINCT FROM 'object' OR p_result->>'availableAt' IS NULL
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) AS f(name) WHERE name NOT IN ('status','payload','availableAt','error','finishedAt')) THEN
    RAISE EXCEPTION 'invalid task result' USING ERRCODE='22023';
  END IF;
  PERFORM (p_result->>'availableAt')::timestamptz;
  SELECT payload INTO current_job FROM public.radar_jobs WHERE id=p_id FOR UPDATE;
  IF current_job IS NULL OR current_job->>'status'<>'running' OR (current_job->>'leaseUntil') IS DISTINCT FROM p_lease_until
    OR (current_job->>'attempts')::integer IS DISTINCT FROM p_attempts
    OR (current_job->>'leaseUntil')::timestamptz<=clock_timestamp() THEN RETURN false; END IF;
  UPDATE public.radar_jobs SET payload=(current_job-'leaseUntil'-'error'-'finishedAt') || p_result WHERE id=p_id;
  RETURN true;
END
$fn$;
$ddl$;
END
$install$;

-- Deployment gate: backend-only table privileges/RLS, function privileges and
-- actual gateway JWT rejection must be reviewed before any cloud installation.
-- Existing application mode stays native until all transaction paths are ported.
