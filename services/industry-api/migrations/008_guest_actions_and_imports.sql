-- Guest R9: auditable actions and idempotent batch aggregate ingestion.
-- Migration is additive, does not modify historic SHA or destroy Guest data.
CREATE TABLE industry.guest_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  pilot_id uuid NOT NULL,
  code varchar(48) NOT NULL CHECK (code ~ '^[A-Z_]{8,48}$'),
  status varchar(16) NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','in_progress','done','dismissed')),
  assigned_to uuid NOT NULL REFERENCES industry.accounts(id),
  created_by uuid NOT NULL REFERENCES industry.accounts(id),
  due_on date NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,pilot_id) REFERENCES industry.guest_pilots(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,pilot_id,code)
);
CREATE INDEX guest_actions_tenant_status_idx
  ON industry.guest_actions(tenant_id,status,due_on,id);

CREATE TABLE industry.guest_bulk_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  pilot_id uuid NOT NULL,
  idempotency_key varchar(80) NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9._:-]{8,80}$'),
  payload_digest char(64) NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  rows_imported integer NOT NULL CHECK(rows_imported BETWEEN 1 AND 12),
  committed_version integer NOT NULL CHECK(committed_version>=1),
  created_by uuid NOT NULL REFERENCES industry.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,pilot_id) REFERENCES industry.guest_pilots(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,pilot_id,idempotency_key)
);
CREATE INDEX guest_bulk_imports_tenant_created_idx
  ON industry.guest_bulk_imports(tenant_id,created_at DESC);

-- Least privilege and the same fail-closed tenant RLS as all Guest evidence tables.
ALTER TABLE industry.guest_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_actions_tenant ON industry.guest_actions FOR ALL
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE industry.guest_bulk_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_bulk_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_bulk_imports_tenant ON industry.guest_bulk_imports FOR ALL
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT,INSERT,UPDATE ON industry.guest_actions TO industry_app;
GRANT SELECT,INSERT ON industry.guest_bulk_imports TO industry_app;
-- No DELETE, TRUNCATE or role/schema modification is granted to the application.
