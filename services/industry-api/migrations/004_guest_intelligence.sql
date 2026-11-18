-- OSMANX Guest Intelligence R4: isolated B2B pilot intake and evidence workflow.
-- No guest names, phone numbers, emails, payment credentials or raw receipts.
-- Runs under migration role; runtime industry_app has NO BYPASSRLS.
CREATE TABLE industry.guest_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES industry.accounts(id),
  title varchar(120) NOT NULL CHECK (char_length(trim(title)) BETWEEN 3 AND 120),
  source varchar(16) NOT NULL CHECK (source IN ('field','referral','site','other')),
  state varchar(16) NOT NULL DEFAULT 'new'
    CHECK (state IN ('new','qualified','declined','converted')),
  idempotency_key varchar(80) NOT NULL,
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key)
);
CREATE INDEX guest_requests_tenant_created_idx ON industry.guest_requests(tenant_id,created_at DESC);

CREATE TABLE industry.guest_pilots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  request_id uuid,
  created_by uuid NOT NULL REFERENCES industry.accounts(id),
  title varchar(120) NOT NULL CHECK (char_length(trim(title)) BETWEEN 3 AND 120),
  phase varchar(20) NOT NULL DEFAULT 'draft'
    CHECK (phase IN ('draft','running','in_review','reviewed','returned','archived')),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan)='object'),
  readiness jsonb NOT NULL CHECK (jsonb_typeof(readiness)='object'),
  target_per_group integer NOT NULL CHECK(target_per_group BETWEEN 1 AND 10000000),
  version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
  submitted_by uuid REFERENCES industry.accounts(id),
  reviewed_by uuid REFERENCES industry.accounts(id),
  submitted_digest char(64) CHECK(submitted_digest IS NULL OR submitted_digest ~ '^[a-f0-9]{64}$'),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,request_id),
  CONSTRAINT guest_pilot_request_fk FOREIGN KEY(tenant_id,request_id)
    REFERENCES industry.guest_requests(tenant_id,id)
);
CREATE INDEX guest_pilots_tenant_created_idx ON industry.guest_pilots(tenant_id,created_at DESC);

CREATE TABLE industry.guest_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  pilot_id uuid NOT NULL,
  observed_on date NOT NULL,
  control_count integer NOT NULL CHECK (control_count BETWEEN 1 AND 10000000),
  control_return integer NOT NULL CHECK (control_return BETWEEN 0 AND control_count),
  offer_count integer NOT NULL CHECK (offer_count BETWEEN 1 AND 10000000),
  offer_return integer NOT NULL CHECK (offer_return BETWEEN 0 AND offer_count),
  idempotency_key varchar(80) NOT NULL,
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL REFERENCES industry.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid REFERENCES industry.accounts(id),
  FOREIGN KEY (tenant_id,pilot_id) REFERENCES industry.guest_pilots(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,pilot_id,idempotency_key),
  CONSTRAINT guest_observation_void_consistency CHECK(
    (voided_at IS NULL AND voided_by IS NULL) OR
    (voided_at IS NOT NULL AND voided_by IS NOT NULL)
  )
);
CREATE UNIQUE INDEX guest_observations_active_period_idx
  ON industry.guest_observations(tenant_id,pilot_id,observed_on)
  WHERE voided_at IS NULL;
CREATE INDEX guest_observations_pilot_idx
  ON industry.guest_observations(tenant_id,pilot_id,observed_on,id);

CREATE TABLE industry.guest_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  pilot_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES industry.accounts(id),
  decision varchar(24) NOT NULL
    CHECK (decision IN ('accept_for_discussion','request_revision')),
  evidence_digest char(64) NOT NULL CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,pilot_id) REFERENCES industry.guest_pilots(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(tenant_id,id)
);
CREATE INDEX guest_reviews_pilot_idx
  ON industry.guest_reviews(tenant_id,pilot_id,decided_at DESC);

-- Strict tenant RLS for all four tables: fail-closed without a transaction tenant context.
ALTER TABLE industry.guest_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_requests_tenant ON industry.guest_requests FOR ALL
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE industry.guest_pilots ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_pilots FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_pilots_tenant ON industry.guest_pilots FOR ALL
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE industry.guest_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_observations_tenant ON industry.guest_observations FOR ALL
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE industry.guest_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_reviews_tenant ON industry.guest_reviews FOR ALL
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

-- Only authenticated application role; migrations and administration stay separate.
GRANT SELECT,INSERT,UPDATE ON industry.guest_requests,industry.guest_pilots,industry.guest_observations TO industry_app;
GRANT SELECT,INSERT ON industry.guest_reviews TO industry_app;
