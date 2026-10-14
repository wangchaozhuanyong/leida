-- Fixed domain operations. Definer writes are constrained to this allowlist;
-- original public tables retain SELECT-only ACL for the backend API role.
DO LANGUAGE plpgsql $write_rpc$
BEGIN
  EXECUTE $ddl$CREATE FUNCTION public.radar_cb_store_read(p_table text,p_after text DEFAULT NULL,p_id text DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog SET timezone='UTC' AS $fn$
  DECLARE fingerprint text; rows jsonb; total integer; result jsonb;
  BEGIN
    IF coalesce(current_setting('request.jwt.claims',true)::jsonb->>'role','')<>'service_role' THEN RAISE EXCEPTION 'backend role required' USING ERRCODE='42501'; END IF;
    IF p_table IS NULL OR NOT p_table=ANY(ARRAY['evidence','candidates','events','articles','publications','sources','jobs','notices','audits','activities','settings','wechat_readers','wechat_grants','wechat_deliveries','forecast_cases','forecast_snapshots','forecast_outcomes']) OR length(coalesce(p_after,''))>512 OR length(coalesce(p_id,''))>512 OR (p_id IS NOT NULL AND p_after IS NOT NULL) THEN RAISE EXCEPTION 'invalid read' USING ERRCODE='22023'; END IF;
    EXECUTE format('SELECT md5(coalesce(string_agg(id || md5(payload::text) || created_at::text, '','' ORDER BY id COLLATE "C"),'''')) FROM public.radar_%I',p_table) INTO fingerprint;
    EXECUTE format('SELECT coalesce(jsonb_agg(jsonb_build_object(''id'',id,''payload'',payload,''createdAt'',created_at) ORDER BY id COLLATE "C"),''[]''::jsonb),count(*) FROM (SELECT id,payload,created_at FROM public.radar_%I WHERE ($1 IS NULL OR id=$1) AND ($2 IS NULL OR id COLLATE "C">$2 COLLATE "C") ORDER BY id COLLATE "C" LIMIT 101) r',p_table) INTO rows,total USING p_id,p_after;
    IF total>100 THEN rows=rows-100; END IF;
    result=jsonb_build_object('fingerprint',fingerprint,'rows',rows,'more',total>100,'after',CASE WHEN total>100 THEN rows->99->>'id' ELSE NULL END);
    IF octet_length(result::text)>1800000 THEN RAISE EXCEPTION 'page exceeds capacity' USING ERRCODE='54000'; END IF;
    RETURN result;
  END;
  $fn$$ddl$;

  EXECUTE $ddl$CREATE FUNCTION public.radar_cb_store_commit(p_expected jsonb,p_changes jsonb,p_lease jsonb DEFAULT NULL) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $fn$
  DECLARE model text; expected text; actual text; change jsonb; value jsonb; kind text; previous jsonb; affected integer;
  BEGIN
    IF coalesce(current_setting('request.jwt.claims',true)::jsonb->>'role','')<>'service_role' THEN RAISE EXCEPTION 'backend role required' USING ERRCODE='42501'; END IF;
    IF jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR jsonb_typeof(p_changes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_changes)>500 OR octet_length(p_changes::text)>1800000 THEN RAISE EXCEPTION 'invalid commit' USING ERRCODE='22023'; END IF;
    -- Deterministic table lock order prevents write skew and phantom insertion.
    FOR model,expected IN SELECT r.key,r.value FROM jsonb_each_text(p_expected) r ORDER BY r.key LOOP
      IF NOT model=ANY(ARRAY['evidence','candidates','events','articles','publications','sources','jobs','notices','audits','activities','settings','wechat_readers','wechat_grants','wechat_deliveries','forecast_cases','forecast_snapshots','forecast_outcomes']) OR expected !~ '^[a-f0-9]{32}$' THEN RAISE EXCEPTION 'invalid read set' USING ERRCODE='22023'; END IF;
      EXECUTE format('LOCK TABLE public.radar_%I IN SHARE ROW EXCLUSIVE MODE',model);
    END LOOP;
    FOR model,expected IN SELECT r.key,r.value FROM jsonb_each_text(p_expected) r ORDER BY r.key LOOP
      EXECUTE format('SELECT md5(coalesce(string_agg(id || md5(payload::text) || created_at::text, '','' ORDER BY id COLLATE "C"),'''')) FROM public.radar_%I',model) INTO actual;
      IF actual<>expected THEN RAISE EXCEPTION 'read set changed' USING ERRCODE='40001'; END IF;
    END LOOP;
    IF p_lease IS NOT NULL THEN
      IF jsonb_typeof(p_lease) IS DISTINCT FROM 'object' OR p_lease->>'name' IS DISTINCT FROM 'radar_auto_publication' THEN RAISE EXCEPTION 'invalid lease' USING ERRCODE='22023'; END IF;
      PERFORM 1 FROM public.radar_cb_leases WHERE name=p_lease->>'name' AND owner=p_lease->>'owner' AND until>clock_timestamp() AND until=(p_lease->>'until')::timestamptz FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'publication lease expired' USING ERRCODE='40001'; END IF;
      SELECT payload INTO previous FROM public.radar_jobs WHERE id=p_lease#>>'{job,id}' FOR UPDATE;
      IF previous IS NULL OR previous->>'status'<>'running' OR previous->>'attempts' IS DISTINCT FROM p_lease#>>'{job,attempts}' OR previous->>'leaseUntil' IS DISTINCT FROM p_lease#>>'{job,leaseUntil}' OR (previous->>'leaseUntil')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'job lease expired' USING ERRCODE='40001'; END IF;
    END IF;
    FOR change IN SELECT * FROM jsonb_array_elements(p_changes) LOOP
      model=change->>'table'; kind=change->>'kind'; value=change->'value';
      IF model IS NULL OR NOT p_expected?model OR kind IS NULL OR NOT kind=ANY(ARRAY['insert','put']) OR jsonb_typeof(value) IS DISTINCT FROM 'object' OR coalesce(value->>'id','')='' OR length(value->>'id')>512 THEN RAISE EXCEPTION 'invalid mutation' USING ERRCODE='22023'; END IF;
      IF kind='put' AND model=ANY(ARRAY['evidence','publications','audits','forecast_snapshots','forecast_outcomes']) THEN RAISE EXCEPTION 'immutable record' USING ERRCODE='22023'; END IF;
      IF kind='insert' THEN
        EXECUTE format('INSERT INTO public.radar_%I(id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING',model) USING value->>'id',value;
        GET DIAGNOSTICS affected=ROW_COUNT;
        IF affected<>1 THEN RAISE EXCEPTION 'insert identity changed' USING ERRCODE='40001'; END IF;
      ELSE
        EXECUTE format('INSERT INTO public.radar_%I(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload',model) USING value->>'id',value;
      END IF;
    END LOOP;
    RETURN true;
  END;
  $fn$$ddl$;

  EXECUTE $ddl$CREATE FUNCTION public.radar_cb_store_lease(p_name text,p_owner text,p_release boolean DEFAULT false) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $fn$
  DECLARE result jsonb;
  BEGIN
    IF coalesce(current_setting('request.jwt.claims',true)::jsonb->>'role','')<>'service_role' THEN RAISE EXCEPTION 'backend role required' USING ERRCODE='42501'; END IF;
    IF p_name IS DISTINCT FROM 'radar_auto_publication' OR p_owner IS NULL OR p_owner !~ '^[a-f0-9-]{36}$' OR p_release IS NULL THEN RAISE EXCEPTION 'invalid lease' USING ERRCODE='22023'; END IF;
    IF p_release THEN
      UPDATE public.radar_cb_leases SET until=clock_timestamp() WHERE name=p_name AND owner=p_owner;
      RETURN NULL;
    END IF;
    INSERT INTO public.radar_cb_leases(name,owner,until) VALUES(p_name,p_owner,clock_timestamp()+interval '60 seconds')
      ON CONFLICT(name) DO UPDATE SET owner=EXCLUDED.owner,until=EXCLUDED.until WHERE radar_cb_leases.until<=clock_timestamp()
      RETURNING jsonb_build_object('name',name,'owner',owner,'until',until) INTO result;
    RETURN result;
  END;
  $fn$$ddl$;
  REVOKE ALL ON FUNCTION public.radar_cb_store_read(text,text,text),public.radar_cb_store_commit(jsonb,jsonb,jsonb),public.radar_cb_store_lease(text,text,boolean) FROM PUBLIC,anon,authenticated;
  GRANT EXECUTE ON FUNCTION public.radar_cb_store_read(text,text,text),public.radar_cb_store_commit(jsonb,jsonb,jsonb),public.radar_cb_store_lease(text,text,boolean) TO service_role;
END;
$write_rpc$;
