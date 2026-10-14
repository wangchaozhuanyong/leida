-- Fixed, backend-only reads. STABLE functions use one MVCC snapshot per RPC.
-- No caller SQL, writes, role changes, transactions across HTTP or business import.
DO LANGUAGE plpgsql $public_functions$
BEGIN
EXECUTE $ddl$
CREATE FUNCTION public.radar_cb_public_version()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog SET timezone='UTC'
AS $fn$
DECLARE digests jsonb:='[]'; model text; digest text;
BEGIN
  IF (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'backend role required' USING ERRCODE='42501'; END IF;
  FOREACH model IN ARRAY ARRAY['events','articles','publications','notices','activities'] LOOP
    EXECUTE format('SELECT md5(coalesce(string_agg(id || md5(payload::text),'','' ORDER BY id),'''')) FROM public.radar_%I',model) INTO digest;
    digests:=digests||to_jsonb(digest);
  END LOOP;
  RETURN jsonb_build_object(
    'digests',digests,
    'sources',(SELECT coalesce(jsonb_agg(payload ORDER BY id),'[]') FROM public.radar_sources),
    'settings',(SELECT coalesce(jsonb_agg(CASE WHEN id='site' THEN payload ELSE jsonb_build_object('id',payload->'id','status',payload->'status','cadenceSnapshotId',payload->'cadenceSnapshotId') END ORDER BY id),'[]') FROM public.radar_settings WHERE id IN ('site','forecast_runtime')),
    'deadlines',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',payload->>'id','action',a->>'id','deadline',a->>'expectedAt') ORDER BY payload->>'id',a->>'id'),'[]') FROM public.radar_events CROSS JOIN LATERAL jsonb_array_elements(payload->'actions') a WHERE a->>'expectedAt' IS NOT NULL),
    'cases',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'digest',md5(payload::text),'w24',payload->'windows'->>'24','w48',payload->'windows'->>'48') ORDER BY id),'[]') FROM public.radar_forecast_cases),
    'snapshots',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'until',payload->>'validUntil','generated',payload->>'generatedAt') ORDER BY id),'[]') FROM public.radar_forecast_snapshots WHERE id=(SELECT payload->>'cadenceSnapshotId' FROM public.radar_settings WHERE id='forecast_runtime') OR id IN (SELECT payload->>'snapshotId' FROM public.radar_forecast_cases)),
    'outcomeDigest',(SELECT md5(coalesce(string_agg(id || md5(payload::text),',' ORDER BY id),'')) FROM public.radar_forecast_outcomes)
  );
END
$fn$;
$ddl$;
EXECUTE $ddl$
CREATE FUNCTION public.radar_cb_forecast_snapshot(p_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog SET timezone='UTC'
AS $fn$
BEGIN
  IF (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'backend role required' USING ERRCODE='42501'; END IF;
  IF p_id IS NULL OR p_id !~ '^(forecast_snapshot_|forecast_cadence_)[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid fixed snapshot id' USING ERRCODE='22023'; END IF;
  RETURN (SELECT payload FROM public.radar_forecast_snapshots WHERE id=p_id);
END
$fn$;
$ddl$;
EXECUTE $ddl$
CREATE FUNCTION public.radar_cb_public_bundle(p_options jsonb,p_now text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog SET timezone='UTC'
AS $fn$
DECLARE view_name text:=p_options->>'view'; filter_name text:=coalesce(p_options->>'filter','all');
  entity_name text:=p_options->>'entity'; object_id text:=p_options->>'id';
  clock_time timestamptz:=p_now::timestamptz; detailed boolean;
  selected text[]:='{}'; all_facts boolean; record_page jsonb; total integer; page_rows jsonb;
  article_ids text[]; event_ids text[]; evidence_ids text[]; parent_ids text[];
  activity jsonb; day_number integer; version_data jsonb; events jsonb; articles jsonb; publications jsonb; evidence jsonb;
  cases jsonb; case_ids text[]; snapshots jsonb; outcomes jsonb;
BEGIN
  IF (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'backend role required' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_options) IS DISTINCT FROM 'object' OR view_name IS NULL OR view_name NOT IN ('home','history','news','detail','activity','notices','methodology','state','calendar','legacy') OR clock_time IS NULL THEN RAISE EXCEPTION 'invalid public scope' USING ERRCODE='22023'; END IF;
  IF object_id IS NOT NULL AND object_id !~ '^[A-Za-z0-9._-]{1,180}$' OR p_options->>'version' IS NOT NULL AND p_options->>'version' !~ '^[A-Za-z0-9._-]{1,180}$' THEN RAISE EXCEPTION 'invalid object id' USING ERRCODE='22023'; END IF;
  IF view_name='detail' AND (object_id IS NULL OR entity_name IS NULL OR entity_name NOT IN ('events','articles','sources','publications')) OR view_name='activity' AND object_id IS NULL THEN RAISE EXCEPTION 'invalid detail scope' USING ERRCODE='22023'; END IF;
  IF view_name='history' AND filter_name NOT IN ('all','automatic_reset','banked_reset') OR view_name='news' AND filter_name NOT IN ('all','reset','product','activity') THEN RAISE EXCEPTION 'invalid filter' USING ERRCODE='22023'; END IF;
  IF p_options ? 'day' AND (jsonb_typeof(p_options->'day') IS DISTINCT FROM 'number' OR (p_options->>'day')::numeric<>trunc((p_options->>'day')::numeric) OR (p_options->>'day')::integer NOT BETWEEN 1 AND 366) THEN RAISE EXCEPTION 'invalid activity day' USING ERRCODE='22023'; END IF;
  IF p_options ? 'publications' AND (jsonb_typeof(p_options->'publications') IS DISTINCT FROM 'array' OR jsonb_array_length(p_options->'publications')>50 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_options->'publications') id WHERE id !~ '^[A-Za-z0-9._-]{1,180}$')) THEN RAISE EXCEPTION 'invalid version list' USING ERRCODE='22023'; END IF;
  IF p_options ? 'cursor' AND (jsonb_typeof(p_options->'cursor') IS DISTINCT FROM 'object' OR p_options->'cursor'->>'view' IS DISTINCT FROM view_name OR p_options->'cursor'->>'filter' IS DISTINCT FROM filter_name OR p_options->'cursor'->>'id' IS NULL OR p_options->'cursor'->>'at' IS NULL OR p_options->'cursor'->>'publishedAt' IS NULL) THEN RAISE EXCEPTION 'invalid cursor' USING ERRCODE='22023'; END IF;
  detailed:=view_name IN ('detail','activity','legacy'); all_facts:=view_name IN ('home','methodology','calendar','legacy');
  version_data:=public.radar_cb_public_version();
  IF view_name IN ('history','news') THEN
    IF view_name='history' THEN
      WITH records AS (
        SELECT p.payload->>'id' AS id,coalesce(greatest((p.payload->'article'->>'sourcePublishedAt')::timestamptz,(SELECT max((action->>'statementAt')::timestamptz) FROM jsonb_array_elements(p.payload->'event'->'actions') action)),(p.payload->'article'->>'publishedAt')::timestamptz) AS at,(p.payload->>'publishedAt')::timestamptz AS published
        FROM public.radar_events e LEFT JOIN public.radar_publications current ON current.id=e.payload->>'publicationId'
        JOIN LATERAL (SELECT CASE WHEN current.id IS NOT NULL AND coalesce(current.payload->>'mode',current.payload->'article'->>'publicationMode','state_change')<>'news_only' THEN current.payload ELSE (SELECT p.payload FROM public.radar_publications p WHERE p.payload->>'eventId'=e.id AND coalesce(p.payload->>'mode',p.payload->'article'->>'publicationMode','state_change')<>'news_only' ORDER BY (p.payload->>'publishedAt')::timestamptz DESC,p.id LIMIT 1) END AS payload) p ON p.payload IS NOT NULL
        WHERE e.payload->>'status'<>'merged' AND jsonb_array_length(p.payload->'event'->'actions')>0 AND (filter_name='all' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.payload->'event'->'actions') action WHERE action->>'kind'=filter_name))
      ), visible AS (
        SELECT * FROM records WHERE NOT (p_options ? 'cursor') OR at<(p_options->'cursor'->>'at')::timestamptz OR (at=(p_options->'cursor'->>'at')::timestamptz AND (published<(p_options->'cursor'->>'publishedAt')::timestamptz OR (published=(p_options->'cursor'->>'publishedAt')::timestamptz AND id>p_options->'cursor'->>'id')))
        ORDER BY at DESC,published DESC,id ASC LIMIT 21
      ) SELECT (SELECT count(*)::integer FROM records),(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY at DESC,published DESC,id ASC),'[]') FROM visible v) INTO total,page_rows;
    ELSE
      WITH records AS (
        SELECT p.payload->>'id' AS id,coalesce((a.payload->>'sourcePublishedAt')::timestamptz,(a.payload->>'publishedAt')::timestamptz) AS at,(p.payload->>'publishedAt')::timestamptz AS published
        FROM public.radar_articles a JOIN public.radar_publications p ON p.id=a.payload->>'publicationId' WHERE filter_name='all' OR a.payload->>'category'=filter_name
      ), visible AS (
        SELECT * FROM records WHERE NOT (p_options ? 'cursor') OR at<(p_options->'cursor'->>'at')::timestamptz OR (at=(p_options->'cursor'->>'at')::timestamptz AND (published<(p_options->'cursor'->>'publishedAt')::timestamptz OR (published=(p_options->'cursor'->>'publishedAt')::timestamptz AND id>p_options->'cursor'->>'id')))
        ORDER BY at DESC,published DESC,id ASC LIMIT 21
      ) SELECT (SELECT count(*)::integer FROM records),(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY at DESC,published DESC,id ASC),'[]') FROM visible v) INTO total,page_rows;
    END IF;
    selected:=ARRAY(SELECT row->>'id' FROM jsonb_array_elements(page_rows) WITH ORDINALITY q(row,n) WHERE n<=20 ORDER BY n);
    record_page:=jsonb_build_object('total',total,'rows',page_rows);
  ELSIF view_name='activity' THEN
    activity:=(SELECT payload FROM public.radar_activities WHERE id=object_id);
    day_number:=coalesce((p_options->>'day')::integer,CASE WHEN activity IS NULL THEN 1 ELSE greatest(1,least((activity->>'days')::integer,((clock_time AT TIME ZONE (activity->>'timezone'))::date-(activity->>'startsOn')::date)+1)) END);
    article_ids:=ARRAY(SELECT item->>'articleId' FROM jsonb_array_elements(activity->'items') item WHERE (item->>'day')::integer=day_number);
    selected:=ARRAY(SELECT payload->>'publicationId' FROM public.radar_articles WHERE id=ANY(article_ids));
    selected:=selected||ARRAY(SELECT id FROM public.radar_publications WHERE id IN (SELECT jsonb_array_elements_text(p_options->'publications')) AND payload->>'articleId'=ANY(article_ids));
  ELSIF view_name='notices' THEN selected:=ARRAY(SELECT payload->>'publicationId' FROM public.radar_notices);
  ELSIF view_name='detail' THEN
    IF entity_name='events' THEN selected:=ARRAY(SELECT id FROM public.radar_publications WHERE payload->>'eventId'=object_id);
    ELSIF entity_name='articles' THEN selected:=ARRAY(SELECT id FROM public.radar_publications WHERE payload->>'articleId'=object_id);
    ELSIF entity_name='publications' THEN selected:=ARRAY[object_id];
    ELSE selected:=ARRAY(SELECT id FROM public.radar_publications WHERE (payload->'article'->'evidenceIds') @> jsonb_build_array(object_id) OR coalesce(payload->'article'->'contextEvidenceIds','[]') @> jsonb_build_array(object_id)); END IF;
  END IF;
  IF detailed AND NOT all_facts THEN
    event_ids:=ARRAY(SELECT payload->>'eventId' FROM public.radar_publications WHERE id=ANY(selected));
    article_ids:=ARRAY(SELECT payload->>'articleId' FROM public.radar_publications WHERE id=ANY(selected));
    selected:=selected||ARRAY(SELECT payload->>'publicationId' FROM public.radar_events WHERE id=ANY(event_ids));
    selected:=selected||ARRAY(SELECT payload->>'publicationId' FROM public.radar_articles WHERE id=ANY(article_ids));
    selected:=selected||ARRAY(SELECT payload->>'publicationId' FROM public.radar_events WHERE id IN (SELECT payload->>'mergedInto' FROM public.radar_events WHERE id=ANY(event_ids)));
  END IF;
  IF all_facts THEN selected:=ARRAY(SELECT id FROM public.radar_publications); END IF;
  event_ids:=ARRAY(SELECT DISTINCT payload->>'eventId' FROM public.radar_publications WHERE id=ANY(selected));
  article_ids:=ARRAY(SELECT DISTINCT payload->>'articleId' FROM public.radar_publications WHERE id=ANY(selected));
  events:=(SELECT coalesce(jsonb_agg(payload ORDER BY created_at DESC,id),'[]') FROM public.radar_events WHERE all_facts OR id=ANY(event_ids));
  articles:=(SELECT coalesce(jsonb_agg(CASE WHEN detailed THEN payload ELSE (payload-'translation'-'summary')||jsonb_build_object('translation','','summary',left(payload->>'summary',360)) END ORDER BY created_at DESC,id),'[]') FROM public.radar_articles WHERE all_facts OR id=ANY(article_ids));
  publications:=(SELECT coalesce(jsonb_agg(CASE WHEN detailed THEN payload ELSE (payload-'article')||jsonb_build_object('article',((payload->'article')-'translation'-'summary')||jsonb_build_object('translation','','summary',left(payload->'article'->>'summary',360))) END ORDER BY created_at DESC,id),'[]') FROM public.radar_publications WHERE id=ANY(selected));
  evidence_ids:=ARRAY(SELECT DISTINCT jsonb_array_elements_text(payload->'article'->'evidenceIds') FROM public.radar_publications WHERE id=ANY(selected));
  IF NOT all_facts THEN
    evidence_ids:=evidence_ids||ARRAY(SELECT jsonb_array_elements_text(payload->'event'->'evidenceIds') FROM public.radar_publications WHERE id=ANY(selected));
    evidence_ids:=evidence_ids||ARRAY(SELECT jsonb_array_elements_text(action->'evidenceIds') FROM public.radar_publications CROSS JOIN LATERAL jsonb_array_elements(payload->'event'->'actions') action WHERE id=ANY(selected));
    evidence_ids:=evidence_ids||ARRAY(SELECT jsonb_array_elements_text(payload->'article'->'contextEvidenceIds') FROM public.radar_publications WHERE id=ANY(selected));
    IF entity_name='sources' AND cardinality(selected)>0 THEN evidence_ids:=evidence_ids||object_id; END IF;
  END IF;
  IF detailed AND view_name<>'legacy' THEN
    parent_ids:=ARRAY(SELECT payload->>'parentId' FROM public.radar_evidence WHERE id=ANY(evidence_ids));
    evidence_ids:=evidence_ids||ARRAY(SELECT id FROM public.radar_evidence WHERE id=ANY(parent_ids) OR payload->>'messageId'=ANY(parent_ids));
  END IF;
  evidence:=(SELECT coalesce(jsonb_agg(CASE WHEN detailed THEN payload ELSE (payload-'text'-'metadata')||jsonb_build_object('text','') END ORDER BY created_at DESC,id),'[]') FROM public.radar_evidence WHERE id=ANY(evidence_ids));
  cases:='[]'; snapshots:='[]'; outcomes:='[]';
  IF view_name IN ('home','methodology','legacy') THEN
    cases:=(SELECT coalesce(jsonb_agg(payload ORDER BY created_at DESC,id),'[]') FROM public.radar_forecast_cases WHERE view_name<>'home' OR (payload->'windows'->>'48')::timestamptz>clock_time);
    case_ids:=ARRAY(SELECT c->>'id' FROM jsonb_array_elements(cases) c);
    outcomes:=(SELECT coalesce(jsonb_agg(payload ORDER BY created_at DESC,id),'[]') FROM public.radar_forecast_outcomes WHERE view_name<>'home' OR payload->>'caseId'=ANY(case_ids));
    snapshots:=(SELECT coalesce(jsonb_agg(CASE WHEN view_name='legacy' THEN payload ELSE (payload-'observations'-'trainingObservationIds'-'trainingIntervals'-'historicalIntervals'-'capacityPadding')||CASE WHEN payload->>'recordType'='reset_cadence' THEN jsonb_build_object('summaryOnly',true,'observations','[]'::jsonb,'trainingObservationIds','[]'::jsonb,'trainingIntervals','[]'::jsonb,'historicalIntervals','[]'::jsonb,'backtest',((payload->'backtest')-'entries')||jsonb_build_object('entries','[]'::jsonb)) ELSE '{}'::jsonb END END ORDER BY created_at DESC,id),'[]') FROM public.radar_forecast_snapshots WHERE view_name='legacy' OR id IN (SELECT c->>'snapshotId' FROM jsonb_array_elements(cases) c) OR id=(SELECT payload->>'cadenceSnapshotId' FROM public.radar_settings WHERE id='forecast_runtime') OR (view_name='methodology' AND id IN (SELECT id FROM public.radar_forecast_snapshots WHERE payload->>'recordType'='reset_cadence' ORDER BY (payload->>'generatedAt')::timestamptz DESC,id LIMIT 12)));
  END IF;
  RETURN jsonb_build_object('versionData',version_data,'events',events,'articles',articles,'publications',publications,'evidence',evidence,
    'activities',(SELECT coalesce(jsonb_agg(payload ORDER BY created_at DESC,id),'[]') FROM public.radar_activities),
    'notices',CASE WHEN view_name IN ('notices','legacy') THEN (SELECT coalesce(jsonb_agg(payload ORDER BY created_at DESC,id),'[]') FROM public.radar_notices) ELSE '[]'::jsonb END,
    'site',(SELECT payload FROM public.radar_settings WHERE id='site'),'page',record_page,
    'forecastRecords',jsonb_build_object('cases',cases,'snapshots',snapshots,'outcomes',outcomes,'runtime',(SELECT jsonb_build_object('status',payload->'status','cadenceSnapshotId',payload->'cadenceSnapshotId') FROM public.radar_settings WHERE id='forecast_runtime')));
END
$fn$;
$ddl$;
REVOKE ALL ON FUNCTION public.radar_cb_public_version(),public.radar_cb_public_bundle(jsonb,text),public.radar_cb_forecast_snapshot(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.radar_cb_public_version(),public.radar_cb_public_bundle(jsonb,text),public.radar_cb_forecast_snapshot(text) TO service_role;
END;
$public_functions$;
