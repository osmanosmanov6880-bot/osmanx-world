CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS industry;
CREATE TABLE industry.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug varchar(64) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  name varchar(120) NOT NULL,
  vertical varchar(20) NOT NULL CHECK (vertical IN ('lab','dental','auto','beauty','fitness','cafe','cleaning')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE industry.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(254) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE industry.memberships (
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES industry.accounts(id) ON DELETE CASCADE,
  role varchar(12) NOT NULL CHECK (role IN ('owner','manager','operator','viewer')),
  PRIMARY KEY (tenant_id, account_id)
);
CREATE TABLE industry.sessions (
  token_hash char(64) PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES industry.accounts(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  csrf_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_account_idx ON industry.sessions (account_id, expires_at);
CREATE TABLE industry.login_attempts (
  email varchar(254) NOT NULL,
  ip_hash char(64) NOT NULL,
  failures integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (email, ip_hash)
);
CREATE TABLE industry.resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  name varchar(100) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE TABLE industry.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  display_name varchar(120) NOT NULL,
  phone varchar(32),
  email varchar(254),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX customers_tenant_idx ON industry.customers (tenant_id, created_at DESC);
CREATE TABLE industry.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE TABLE industry.appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  service_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  idempotency_key varchar(80),
  status varchar(12) NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','confirmed','done','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_slot CHECK (ends_at > starts_at),
  CONSTRAINT appointments_customer_fk FOREIGN KEY (tenant_id, customer_id)
    REFERENCES industry.customers(tenant_id, id),
  CONSTRAINT appointments_service_fk FOREIGN KEY (tenant_id, service_id)
    REFERENCES industry.services(tenant_id, id),
  CONSTRAINT appointments_resource_fk FOREIGN KEY (tenant_id, resource_id)
    REFERENCES industry.resources(tenant_id, id),
  UNIQUE (tenant_id, id),
  CONSTRAINT prevent_resource_overbooking EXCLUDE USING gist (
    tenant_id WITH =, resource_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('new','confirmed'))
);
CREATE UNIQUE INDEX appointments_idempotency_idx ON industry.appointments (tenant_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX appointments_tenant_start_idx ON industry.appointments (tenant_id, starts_at DESC);
CREATE TABLE industry.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES industry.accounts(id),
  action varchar(80) NOT NULL,
  target_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_time_idx ON industry.audit_events(tenant_id, occurred_at DESC);
CREATE TABLE industry.outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  kind varchar(80) NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  delivered_at timestamptz,
  dead_at timestamptz,
  last_error varchar(240),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_queued_idx ON industry.outbox(available_at, created_at)
  WHERE delivered_at IS NULL AND dead_at IS NULL;
-- Every tenant-owned row is protected by tenant-scoped Row Level Security.
ALTER TABLE industry.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON industry.tenants FOR ALL
  USING (id = NULLIF(current_setting('app.tenant_id', true),'')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true),'')::uuid);
ALTER TABLE industry.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY members_tenant ON industry.memberships FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid);
ALTER TABLE industry.resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.resources FORCE ROW LEVEL SECURITY;
CREATE POLICY resources_tenant ON industry.resources FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid);
ALTER TABLE industry.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.customers FORCE ROW LEVEL SECURITY;
CREATE POLICY customers_tenant ON industry.customers FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid);
ALTER TABLE industry.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.services FORCE ROW LEVEL SECURITY;
CREATE POLICY services_tenant ON industry.services FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid);
ALTER TABLE industry.appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.appointments FORCE ROW LEVEL SECURITY;
CREATE POLICY appointments_tenant ON industry.appointments FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid);
ALTER TABLE industry.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_tenant ON industry.audit_events FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid);
ALTER TABLE industry.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_tenant ON industry.outbox FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid);
REVOKE ALL ON SCHEMA industry FROM PUBLIC;
GRANT USAGE ON SCHEMA industry TO industry_app, industry_worker;
GRANT SELECT ON industry.accounts, industry.tenants, industry.memberships TO industry_app;
GRANT SELECT, INSERT, DELETE ON industry.sessions TO industry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON industry.login_attempts TO industry_app;
GRANT SELECT, INSERT, UPDATE ON industry.resources, industry.customers, industry.services, industry.appointments TO industry_app;
GRANT SELECT, INSERT ON industry.audit_events, industry.outbox TO industry_app;
GRANT SELECT, UPDATE ON industry.outbox TO industry_worker;

-- Only reveal the UUID of a tenant by its public slug to the login flow.
CREATE FUNCTION industry.find_tenant(p_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=industry,pg_temp
AS 'SELECT id FROM industry.tenants WHERE slug=p_slug LIMIT 1';
REVOKE ALL ON FUNCTION industry.find_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION industry.find_tenant(text) TO industry_app;
