-- Review-only candidate for the NEW, EMPTY leida-test validation tables.
-- No credential, role creation, ownership change, data import or deletion.
DO LANGUAGE plpgsql $permissions$
DECLARE model text; signature text;
BEGIN
  FOREACH model IN ARRAY ARRAY['user','account','session','verification','radar_jobs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',model);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated',model);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO service_role',model);
    EXECUTE format('CREATE POLICY radar_cloudbase_backend ON public.%I TO service_role USING(true) WITH CHECK(true)',model);
  END LOOP;
  FOREACH signature IN ARRAY ARRAY['radar_cb_auth_snapshot()','radar_cb_auth_commit(text,jsonb)','radar_cb_claim_job()','radar_cb_finish_job(text,text,integer,jsonb)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION public.'||signature||' FROM PUBLIC,anon,authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||signature||' TO service_role';
  END LOOP;
END;
$permissions$;
