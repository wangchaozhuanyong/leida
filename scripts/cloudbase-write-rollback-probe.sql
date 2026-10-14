-- Empty leida-test only. Synthetic rows exist exclusively inside a rolled-back
-- subtransaction; no business imports, credentials or provider requests.
DO LANGUAGE plpgsql $write_probe$
DECLARE checks integer=0; passed boolean=false; expected jsonb; lease jsonb; job jsonb;
BEGIN
  IF EXISTS(SELECT 1 FROM public.radar_settings UNION ALL SELECT 1 FROM public.radar_audits UNION ALL SELECT 1 FROM public.radar_jobs UNION ALL SELECT 1 FROM public.radar_cb_leases) THEN RAISE EXCEPTION 'requires empty write validation database'; END IF;
  BEGIN
    PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
    expected=jsonb_build_object('settings',public.radar_cb_store_read('settings')->>'fingerprint','audits',public.radar_cb_store_read('audits')->>'fingerprint');
    PERFORM public.radar_cb_store_commit(expected,'[{"table":"settings","kind":"insert","value":{"id":"qa-rollback-setting","count":1}},{"table":"audits","kind":"insert","value":{"id":"qa-rollback-audit","action":"synthetic"}}]'::jsonb);
    IF (SELECT count(*) FROM public.radar_settings WHERE id='qa-rollback-setting')<>1 OR (SELECT count(*) FROM public.radar_audits WHERE id='qa-rollback-audit')<>1 THEN RAISE EXCEPTION 'atomic write probe failed'; END IF;
    checks=checks+1;
    BEGIN
      expected=jsonb_build_object('settings',public.radar_cb_store_read('settings')->>'fingerprint','audits',public.radar_cb_store_read('audits')->>'fingerprint');
      PERFORM public.radar_cb_store_commit(expected,'[{"table":"settings","kind":"insert","value":{"id":"qa-invalid-first"}},{"table":"audits","kind":"put","value":{"id":"qa-rollback-audit"}}]'::jsonb);
      RAISE EXCEPTION 'invalid mutation unexpectedly accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN checks=checks+1;
    END;
    IF EXISTS(SELECT 1 FROM public.radar_settings WHERE id='qa-invalid-first') THEN RAISE EXCEPTION 'partial commit detected'; END IF;
    BEGIN
      PERFORM public.radar_cb_store_commit('{"settings":"ffffffffffffffffffffffffffffffff"}'::jsonb,'[]'::jsonb);
      RAISE EXCEPTION 'stale read set unexpectedly accepted';
    EXCEPTION WHEN SQLSTATE '40001' THEN checks=checks+1;
    END;
    BEGIN
      UPDATE public.radar_audits SET payload=payload||'{"changed":true}'::jsonb WHERE id='qa-rollback-audit';
      RAISE EXCEPTION 'immutable audit unexpectedly overwritten';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM<>'immutable record' THEN RAISE; END IF; checks=checks+1;
    END;
    job=jsonb_build_object('id','qa-rollback-job','kind','generate','status','running','attempts',1,'leaseUntil',clock_timestamp()+interval '120 seconds','createdAt',clock_timestamp(),'availableAt',clock_timestamp(),'payload','{}'::jsonb);
    PERFORM public.radar_cb_store_commit(jsonb_build_object('jobs',public.radar_cb_store_read('jobs')->>'fingerprint'),jsonb_build_array(jsonb_build_object('table','jobs','kind','insert','value',job)));
    lease=public.radar_cb_store_lease('radar_auto_publication','00000000-0000-4000-8000-000000000001',false);
    IF lease IS NULL OR public.radar_cb_store_lease('radar_auto_publication','00000000-0000-4000-8000-000000000002',false) IS NOT NULL THEN RAISE EXCEPTION 'lease exclusion failed'; END IF;
    checks=checks+1;
    lease=lease||jsonb_build_object('job',jsonb_build_object('id',job->>'id','attempts',job->'attempts','leaseUntil',job->>'leaseUntil'));
    UPDATE public.radar_cb_leases SET until=clock_timestamp()-interval '1 second' WHERE name='radar_auto_publication';
    BEGIN
      PERFORM public.radar_cb_store_commit(jsonb_build_object('settings',public.radar_cb_store_read('settings')->>'fingerprint'),'[{"table":"settings","kind":"insert","value":{"id":"qa-expired-holder"}}]'::jsonb,lease);
      RAISE EXCEPTION 'expired holder unexpectedly committed';
    EXCEPTION WHEN SQLSTATE '40001' THEN checks=checks+1;
    END;
    IF EXISTS(SELECT 1 FROM public.radar_settings WHERE id='qa-expired-holder') THEN RAISE EXCEPTION 'expired lease persisted result'; END IF;
    RAISE EXCEPTION 'intentional_qa_rollback' USING ERRCODE='P0002';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN
    IF SQLERRM<>'intentional_qa_rollback' OR checks<>6 THEN RAISE; END IF;
    passed=true;
  END;
  IF NOT passed OR EXISTS(SELECT 1 FROM public.radar_settings UNION ALL SELECT 1 FROM public.radar_audits UNION ALL SELECT 1 FROM public.radar_jobs UNION ALL SELECT 1 FROM public.radar_cb_leases) THEN RAISE EXCEPTION 'rollback validation failed'; END IF;
END;
$write_probe$;
