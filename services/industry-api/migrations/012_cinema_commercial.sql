-- OSMANX CINEMA R3: least-privilege, tenant-scoped commercial intake.
-- Intentionally no public DB role, no browser-to-database access.
CREATE TABLE industry.cinema_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  contact_name varchar(120) NOT NULL,
  contact_email varchar(254) NOT NULL,
  organization varchar(120),
  story_id varchar(40) NOT NULL CHECK (story_id ~ '^[0-9]{2}-[a-z-]+$'),
  observation varchar(500) NOT NULL,
  goal varchar(300),
  source varchar(24) NOT NULL DEFAULT 'cinema' CHECK (source IN ('cinema','guest','catalog','industry')),
  consent_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key varchar(80) NOT NULL,
  payload_digest char(64) NOT NULL CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
  state varchar(16) NOT NULL DEFAULT 'new'
    CHECK(state IN ('new','contacted','qualified','proposal','won','lost')),
  deal_value_minor bigint CHECK(deal_value_minor IS NULL OR (deal_value_minor>=0 AND deal_value_minor<=100000000000)),
  currency char(3) NOT NULL DEFAULT 'RUB' CHECK(currency='RUB'),
  version integer NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,idempotency_key)
);
CREATE INDEX cinema_leads_tenant_created_idx ON industry.cinema_leads(tenant_id,created_at DESC,id DESC);
CREATE INDEX cinema_leads_tenant_state_idx ON industry.cinema_leads(tenant_id,state,updated_at DESC);
CREATE TABLE industry.cinema_lead_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  lead_id uuid NOT NULL,
  actor_id uuid REFERENCES industry.accounts(id),
  event_type varchar(24) NOT NULL CHECK(event_type IN ('created','state_changed','value_changed')),
  old_state varchar(16),
  new_state varchar(16),
  version integer NOT NULL CHECK(version>=1),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,lead_id) REFERENCES industry.cinema_leads(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(tenant_id,lead_id,version)
);
CREATE INDEX cinema_lead_events_lead_idx ON industry.cinema_lead_events(tenant_id,lead_id,occurred_at);
CREATE TABLE industry.cinema_rate_limits (
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  key_hash char(64) NOT NULL,
  bucket_hour timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 1 CHECK(hits>=1),
  PRIMARY KEY(tenant_id,key_hash,bucket_hour)
);
CREATE TABLE industry.cinema_daily_events (
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  date_utc date NOT NULL,
  event_type varchar(24) NOT NULL CHECK(event_type IN ('film_started','film_finished','brief_created','offer_opened')),
  story_id varchar(40) NOT NULL DEFAULT 'all',
  total bigint NOT NULL DEFAULT 0 CHECK(total>=0),
  PRIMARY KEY(tenant_id,date_utc,event_type,story_id)
);
-- A shared runtime role must never bypass tenant context.
ALTER TABLE industry.cinema_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.cinema_leads FORCE ROW LEVEL SECURITY;
CREATE POLICY cinema_leads_tenant ON industry.cinema_leads FOR ALL
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE industry.cinema_lead_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.cinema_lead_events FORCE ROW LEVEL SECURITY;
CREATE POLICY cinema_lead_events_tenant ON industry.cinema_lead_events FOR ALL
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE industry.cinema_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.cinema_rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY cinema_rate_limits_tenant ON industry.cinema_rate_limits FOR ALL
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE industry.cinema_daily_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.cinema_daily_events FORCE ROW LEVEL SECURITY;
CREATE POLICY cinema_daily_events_tenant ON industry.cinema_daily_events FOR ALL
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON industry.cinema_leads TO industry_app;
GRANT SELECT,INSERT ON industry.cinema_lead_events TO industry_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON industry.cinema_rate_limits TO industry_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON industry.cinema_daily_events TO industry_app;
