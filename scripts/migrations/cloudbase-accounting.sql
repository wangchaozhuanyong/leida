-- New empty leida-test only. Fixed metadata and accounting operations, no AI calls.
DO LANGUAGE plpgsql $accounting$
BEGIN
  CREATE TABLE public.radar_ai_usage(id text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now(),model text NOT NULL,input_tokens integer NOT NULL DEFAULT 0,output_tokens integer NOT NULL DEFAULT 0,cost numeric NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'reserved',input_price numeric NOT NULL,output_price numeric NOT NULL);
  CREATE INDEX radar_ai_usage_created ON public.radar_ai_usage(created_at);
  ALTER TABLE public.radar_ai_usage ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public.radar_ai_usage FROM PUBLIC,anon,authenticated,service_role;
  GRANT SELECT ON TABLE public.radar_ai_usage TO service_role;
  CREATE POLICY radar_cb_ai_read ON public.radar_ai_usage FOR SELECT TO service_role USING(true);

  EXECUTE $ddl$CREATE FUNCTION public.radar_cb_owner_exists() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
  BEGIN
    IF coalesce(current_setting('request.jwt.claims',true)::jsonb->>'role','')<>'service_role' THEN RAISE EXCEPTION 'backend role required' USING ERRCODE='42501'; END IF;
    RETURN EXISTS(SELECT 1 FROM public."user");
  END;
  $fn$$ddl$;

  EXECUTE $ddl$CREATE FUNCTION public.radar_cb_ai_summary() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $fn$
  BEGIN
    IF coalesce(current_setting('request.jwt.claims',true)::jsonb->>'role','')<>'service_role' THEN RAISE EXCEPTION 'backend role required' USING ERRCODE='42501'; END IF;
    RETURN (SELECT jsonb_build_object('calls',count(*),'cost',coalesce(sum(cost),0)) FROM public.radar_ai_usage WHERE created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai');
  END;
  $fn$$ddl$;

  EXECUTE $ddl$CREATE FUNCTION public.radar_cb_ai_reserve(p_id text,p_version integer,p_input_bound integer) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $fn$
  DECLARE config jsonb; day_start timestamptz; calls bigint; cost numeric; reserved_cost numeric; in_price numeric; out_price numeric; limit_calls integer; budget numeric;
  BEGIN
    IF coalesce(current_setting('request.jwt.claims',true)::jsonb->>'role','')<>'service_role' THEN RAISE EXCEPTION 'backend role required' USING ERRCODE='42501'; END IF;
    IF p_id IS NULL OR p_id !~ '^[a-zA-Z0-9_-]{1,160}$' OR p_version IS NULL OR p_version<1 OR p_input_bound IS NULL OR p_input_bound<1 OR p_input_bound>2000000 THEN RAISE EXCEPTION 'invalid reservation' USING ERRCODE='22023'; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('radar_ai_budget'));
    SELECT payload INTO config FROM public.radar_settings WHERE id='ai' FOR SHARE;
    IF config IS NULL OR (config->>'version')::integer IS DISTINCT FROM p_version OR coalesce(config->>'model','')='' THEN RETURN 'configuration'; END IF;
    in_price=(config->>'inputPrice')::numeric; out_price=(config->>'outputPrice')::numeric; limit_calls=(config->>'dailyCallLimit')::integer; budget=(config->>'dailyBudget')::numeric;
    IF in_price IS NULL OR out_price IS NULL OR limit_calls IS NULL OR budget IS NULL OR in_price<=0 OR out_price<=0 OR limit_calls<=0 OR budget<=0 THEN RETURN 'configuration'; END IF;
    day_start=date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
    SELECT count(*),coalesce(sum(u.cost),0) INTO calls,cost FROM public.radar_ai_usage u WHERE created_at>=day_start;
    reserved_cost=(p_input_bound*in_price+1800*out_price)/1000000;
    IF calls>=limit_calls OR cost+reserved_cost>budget THEN RETURN 'budget'; END IF;
    INSERT INTO public.radar_ai_usage(id,model,cost,input_price,output_price) VALUES(p_id,config->>'model',reserved_cost,in_price,out_price);
    RETURN 'reserved';
  END;
  $fn$$ddl$;

  EXECUTE $ddl$CREATE FUNCTION public.radar_cb_ai_finish(p_id text,p_status text,p_input_tokens integer DEFAULT NULL,p_output_tokens integer DEFAULT NULL) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $fn$
  DECLARE previous public.radar_ai_usage%ROWTYPE;
  BEGIN
    IF coalesce(current_setting('request.jwt.claims',true)::jsonb->>'role','')<>'service_role' THEN RAISE EXCEPTION 'backend role required' USING ERRCODE='42501'; END IF;
    IF p_id IS NULL OR p_status IS NULL OR NOT p_status=ANY(ARRAY['succeeded','estimated','failed']) OR p_status<>'failed' AND (p_input_tokens IS NULL OR p_output_tokens IS NULL OR p_input_tokens<0 OR p_output_tokens<0) THEN RAISE EXCEPTION 'invalid accounting result' USING ERRCODE='22023'; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('radar_ai_budget'));
    SELECT * INTO previous FROM public.radar_ai_usage WHERE id=p_id FOR UPDATE;
    IF NOT FOUND THEN RETURN 'missing'; END IF;
    IF previous.status<>'reserved' THEN RETURN 'settled'; END IF;
    IF p_status='failed' THEN UPDATE public.radar_ai_usage SET status='failed' WHERE id=p_id;
    ELSE UPDATE public.radar_ai_usage SET status=p_status,input_tokens=p_input_tokens,output_tokens=p_output_tokens,cost=(p_input_tokens*previous.input_price+p_output_tokens*previous.output_price)/1000000 WHERE id=p_id;
    END IF;
    RETURN 'recorded';
  END;
  $fn$$ddl$;
  REVOKE ALL ON FUNCTION public.radar_cb_owner_exists(),public.radar_cb_ai_summary(),public.radar_cb_ai_reserve(text,integer,integer),public.radar_cb_ai_finish(text,text,integer,integer) FROM PUBLIC,anon,authenticated;
  GRANT EXECUTE ON FUNCTION public.radar_cb_owner_exists(),public.radar_cb_ai_summary(),public.radar_cb_ai_reserve(text,integer,integer),public.radar_cb_ai_finish(text,text,integer,integer) TO service_role;
END;
$accounting$;
