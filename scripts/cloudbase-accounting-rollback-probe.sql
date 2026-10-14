-- Synthetic SQL only. All configuration/reservations below are rolled back.
DO LANGUAGE plpgsql $accounting_probe$
DECLARE checks integer=0; passed boolean=false; config jsonb; summary jsonb; completion text;
BEGIN
  IF EXISTS(SELECT 1 FROM public.radar_ai_usage) OR EXISTS(SELECT 1 FROM public.radar_settings WHERE id='ai') THEN RAISE EXCEPTION 'requires empty accounting probe'; END IF;
  BEGIN
    PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
    summary=public.radar_cb_ai_summary();
    IF (summary->>'calls')::integer<>0 OR (summary->>'cost')::numeric<>0 THEN RAISE EXCEPTION 'empty accounting summary failed'; END IF;
    checks=checks+1;
    config='{"id":"ai","enabled":false,"model":"qa-only-no-provider","version":1,"dailyCallLimit":1,"dailyBudget":1,"inputPrice":1,"outputPrice":1,"currency":"CNY"}'::jsonb;
    PERFORM public.radar_cb_store_commit(jsonb_build_object('settings',public.radar_cb_store_read('settings')->>'fingerprint'),jsonb_build_array(jsonb_build_object('table','settings','kind','insert','value',config)));
    IF public.radar_cb_ai_reserve('usage-rollback',1,1000)<>'reserved' THEN RAISE EXCEPTION 'reservation failed'; END IF;
    summary=public.radar_cb_ai_summary();
    IF (summary->>'calls')::integer<>1 OR (summary->>'cost')::numeric<>0.0028 THEN RAISE EXCEPTION 'reservation summary failed'; END IF;
    checks=checks+1;
    IF public.radar_cb_ai_reserve('usage-over-limit',1,1000)<>'budget' THEN RAISE EXCEPTION 'budget limit failed'; END IF;
    checks=checks+1;
    config=config||'{"version":2,"inputPrice":99,"outputPrice":99}'::jsonb;
    PERFORM public.radar_cb_store_commit(jsonb_build_object('settings',public.radar_cb_store_read('settings')->>'fingerprint'),jsonb_build_array(jsonb_build_object('table','settings','kind','put','value',config)));
    -- The write and read need separate SQL command snapshots inside this DO.
    completion=public.radar_cb_ai_finish('usage-rollback','succeeded',130,10);
    IF completion<>'recorded' OR (SELECT cost FROM public.radar_ai_usage WHERE id='usage-rollback')<>0.00014 THEN RAISE EXCEPTION 'captured price accounting failed'; END IF;
    checks=checks+1;
    IF public.radar_cb_ai_finish('usage-rollback','failed')<>'settled' OR public.radar_cb_ai_finish('usage-rollback','succeeded',999,999)<>'settled' OR (SELECT cost FROM public.radar_ai_usage WHERE id='usage-rollback')<>0.00014 THEN RAISE EXCEPTION 'once-only accounting failed'; END IF;
    checks=checks+1;
    IF public.radar_cb_ai_reserve('usage-stale',1,1000)<>'configuration' THEN RAISE EXCEPTION 'version gate failed'; END IF;
    checks=checks+1;
    config=config||'{"version":3,"dailyBudget":0}'::jsonb;
    PERFORM public.radar_cb_store_commit(jsonb_build_object('settings',public.radar_cb_store_read('settings')->>'fingerprint'),jsonb_build_array(jsonb_build_object('table','settings','kind','put','value',config)));
    IF public.radar_cb_ai_reserve('usage-no-ceiling',3,1000)<>'configuration' THEN RAISE EXCEPTION 'disabled budget gate failed'; END IF;
    checks=checks+1;
    RAISE EXCEPTION 'intentional_accounting_rollback' USING ERRCODE='P0002';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN
    IF SQLERRM<>'intentional_accounting_rollback' OR checks<>7 THEN RAISE; END IF; passed=true;
  END;
  IF NOT passed OR EXISTS(SELECT 1 FROM public.radar_ai_usage) OR EXISTS(SELECT 1 FROM public.radar_settings WHERE id='ai') THEN RAISE EXCEPTION 'accounting rollback failed'; END IF;
END;
$accounting_probe$;
