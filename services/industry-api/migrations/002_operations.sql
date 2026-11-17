-- OSMANX R4: staff onboarding, scheduling and reliable delivery.
-- Apply as migration role only; all tenant-owned tables use FORCE RLS.
ALTER TABLE industry.tenants ADD COLUMN timezone text NOT NULL DEFAULT 'UTC';
CREATE TABLE industry.invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
 email varchar(254) NOT NULL,
 role varchar(12) NOT NULL CHECK (role IN ('manager','operator','viewer')),
 token_hash char(64) NOT NULL UNIQUE,
 created_by uuid NOT NULL REFERENCES industry.accounts(id),
 expires_at timestamptz NOT NULL,
 accepted_at timestamptz,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,id)
);
CREATE INDEX invitation_active_idx ON industry.invitations (tenant_id,created_at DESC);
ALTER TABLE industry.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY invitations_tenant ON industry.invitations FOR ALL
 USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON industry.invitations TO industry_app;
GRANT INSERT ON industry.accounts TO industry_app;
GRANT INSERT,UPDATE,DELETE ON industry.memberships TO industry_app;
-- Token-only tenant resolution. Token hashes must have 256-bit entropy.
CREATE FUNCTION industry.resolve_invitation(p_hash char(64))
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=industry,pg_temp
AS 'SELECT i.tenant_id FROM industry.invitations i WHERE i.token_hash=p_hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now() LIMIT 1';
REVOKE ALL ON FUNCTION industry.resolve_invitation(char(64)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION industry.resolve_invitation(char(64)) TO industry_app;

CREATE TABLE industry.resource_hours (
 tenant_id uuid NOT NULL,
 resource_id uuid NOT NULL,
 weekday integer NOT NULL CHECK (weekday BETWEEN 1 AND 7),
 opens_at time NOT NULL,
 closes_at time NOT NULL,
 CONSTRAINT resource_hours_valid CHECK (opens_at < closes_at),
 PRIMARY KEY (tenant_id,resource_id,weekday),
 FOREIGN KEY (tenant_id,resource_id) REFERENCES industry.resources(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE industry.resource_time_off (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 resource_id uuid NOT NULL,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 reason varchar(160) NOT NULL DEFAULT 'Недоступно',
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id,resource_id) REFERENCES industry.resources(tenant_id,id) ON DELETE CASCADE,
 CONSTRAINT time_off_valid CHECK (ends_at>starts_at),
 CONSTRAINT prevent_overlap_time_off EXCLUDE USING gist (
  tenant_id WITH =,resource_id WITH =, tstzrange(starts_at,ends_at,'[)') WITH &&
 )
);
CREATE INDEX time_off_tenant_idx ON industry.resource_time_off(tenant_id,starts_at DESC);
-- Default hours for preexisting resources, Mon-Sat 09:00-18:00 UTC,
-- can be replaced with per-company time zone and schedule via API.
INSERT INTO industry.resource_hours(tenant_id,resource_id,weekday,opens_at,closes_at)
 SELECT tenant_id,id,w,'09:00'::time,'18:00'::time FROM industry.resources
 CROSS JOIN generate_series(1,6) AS w;
ALTER TABLE industry.resource_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.resource_hours FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_hours_tenant ON industry.resource_hours FOR ALL
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE industry.resource_time_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.resource_time_off FORCE ROW LEVEL SECURITY;
CREATE POLICY time_off_tenant ON industry.resource_time_off FOR ALL
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON industry.resource_hours,industry.resource_time_off TO industry_app;
GRANT UPDATE ON industry.tenants TO industry_app;

-- Per-delivery lease token prevents stale worker acknowledgements.
ALTER TABLE industry.outbox ADD COLUMN lease_token uuid;
