-- New EMPTY leida-test only. Fail on existing objects; never import or replace rows.
DO LANGUAGE plpgsql $public_schema$
DECLARE model text;
BEGIN
  FOREACH model IN ARRAY ARRAY['evidence','events','articles','publications','sources','notices','activities','settings','forecast_cases','forecast_snapshots','forecast_outcomes'] LOOP
    EXECUTE format('CREATE TABLE public.radar_%I (id text PRIMARY KEY,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now())',model);
    EXECUTE format('ALTER TABLE public.radar_%I ENABLE ROW LEVEL SECURITY',model);
    -- CloudBase's default ACL grants service_role writes on new tables.
    EXECUTE format('REVOKE ALL ON TABLE public.radar_%I FROM PUBLIC,anon,authenticated,service_role',model);
    -- Read-only public API adapter; later write workflows need their own gate.
    EXECUTE format('GRANT SELECT ON TABLE public.radar_%I TO service_role',model);
    EXECUTE format('CREATE POLICY radar_cloudbase_public_read ON public.radar_%I FOR SELECT TO service_role USING(true)',model);
  END LOOP;
  CREATE UNIQUE INDEX radar_evidence_identity ON public.radar_evidence ((payload->>'sourceId'),(payload->>'messageId'),(payload->>'hash'));
  CREATE UNIQUE INDEX radar_notice_semantic ON public.radar_notices ((payload->>'semanticKey'));
  CREATE UNIQUE INDEX radar_forecast_snapshot_signature ON public.radar_forecast_snapshots ((payload->>'signature'));
  CREATE UNIQUE INDEX radar_forecast_case_identity ON public.radar_forecast_cases ((payload->>'identity'),(payload->>'target'));
  CREATE UNIQUE INDEX radar_forecast_outcome_signature ON public.radar_forecast_outcomes ((payload->>'signature'));
  CREATE INDEX radar_forecast_case_status ON public.radar_forecast_cases ((payload->>'status'));
  CREATE INDEX radar_publication_event ON public.radar_publications ((payload->>'eventId'));
  CREATE INDEX radar_publication_article ON public.radar_publications ((payload->>'articleId'));
  EXECUTE $immutable$CREATE FUNCTION public.radar_cb_public_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $guard$ BEGIN RAISE EXCEPTION 'immutable record'; END $guard$$immutable$;
  REVOKE ALL ON FUNCTION public.radar_cb_public_immutable() FROM PUBLIC,anon,authenticated,service_role;
  FOREACH model IN ARRAY ARRAY['evidence','publications','forecast_snapshots','forecast_outcomes'] LOOP
    EXECUTE format('CREATE TRIGGER radar_cloudbase_immutable_guard BEFORE UPDATE OR DELETE ON public.radar_%I FOR EACH ROW EXECUTE FUNCTION public.radar_cb_public_immutable()',model);
  END LOOP;
END;
$public_schema$;
