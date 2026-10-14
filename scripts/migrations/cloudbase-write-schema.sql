-- Install only in the authorized empty leida-test environment. No imports/deletes.
DO LANGUAGE plpgsql $write_schema$
DECLARE model text;
BEGIN
  FOREACH model IN ARRAY ARRAY['candidates','audits','wechat_readers','wechat_grants','wechat_deliveries'] LOOP
    EXECUTE format('CREATE TABLE public.radar_%I (id text PRIMARY KEY,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now())',model);
    EXECUTE format('ALTER TABLE public.radar_%I ENABLE ROW LEVEL SECURITY',model);
    EXECUTE format('REVOKE ALL ON TABLE public.radar_%I FROM PUBLIC,anon,authenticated,service_role',model);
    EXECUTE format('GRANT SELECT ON TABLE public.radar_%I TO service_role',model);
    EXECUTE format('CREATE POLICY radar_cloudbase_write_read ON public.radar_%I FOR SELECT TO service_role USING(true)',model);
  END LOOP;
  CREATE INDEX radar_candidate_status ON public.radar_candidates ((payload->>'status'));
  CREATE UNIQUE INDEX radar_wechat_reader_identity ON public.radar_wechat_readers ((payload->>'appId'),(payload->>'openidHash'));
  CREATE UNIQUE INDEX radar_wechat_grant_identity ON public.radar_wechat_grants ((payload->>'readerId'),(payload->>'templateId'));
  CREATE UNIQUE INDEX radar_wechat_delivery_identity ON public.radar_wechat_deliveries ((payload->>'noticeId'),(payload->>'readerId'),(payload->>'templateId'));
  CREATE INDEX radar_wechat_delivery_status ON public.radar_wechat_deliveries ((payload->>'status'));
  CREATE TRIGGER radar_cloudbase_immutable_guard BEFORE UPDATE OR DELETE ON public.radar_audits FOR EACH ROW EXECUTE FUNCTION public.radar_cb_public_immutable();
  CREATE TABLE public.radar_cb_leases(name text PRIMARY KEY,owner text NOT NULL,until timestamptz NOT NULL);
  ALTER TABLE public.radar_cb_leases ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public.radar_cb_leases FROM PUBLIC,anon,authenticated,service_role;
END;
$write_schema$;
