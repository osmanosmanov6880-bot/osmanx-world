-- R12 optional, irreversible, dual-human launch gate for new/pending pilot studies.
-- Existing pilots remain unenrolled; historical evidence and archives untouched.
ALTER TABLE industry.guest_pilots
  ADD COLUMN launch_gate_enrolled_at timestamptz;

CREATE OR REPLACE FUNCTION industry.prevent_guest_launch_unenroll()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.launch_gate_enrolled_at IS NOT NULL AND
     OLD.launch_gate_enrolled_at IS DISTINCT FROM NEW.launch_gate_enrolled_at THEN
    RAISE EXCEPTION 'R12 launch gate enrollment is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guest_launch_enrollment_immutable
  BEFORE UPDATE ON industry.guest_pilots
  FOR EACH ROW EXECUTE FUNCTION industry.prevent_guest_launch_unenroll();

CREATE TABLE industry.guest_launch_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  pilot_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES industry.accounts(id),
  role varchar(16) NOT NULL CHECK(role IN ('owner','manager')),
  snapshot_digest char(64) NOT NULL CHECK(snapshot_digest ~ '^[a-f0-9]{64}$'),
  pilot_version integer NOT NULL CHECK(pilot_version>=1),
  idempotency_key varchar(80) NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9._:-]{8,80}$'),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '14 days',
  FOREIGN KEY(tenant_id,pilot_id) REFERENCES industry.guest_pilots(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT guest_launch_attestation_ttl CHECK (
    expires_at > accepted_at AND expires_at <= accepted_at+interval '14 days 1 minute'
  ),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,pilot_id,idempotency_key)
);
CREATE INDEX guest_launch_attestation_latest_idx
  ON industry.guest_launch_attestations(tenant_id,pilot_id,role,accepted_at DESC,id DESC);

ALTER TABLE industry.guest_launch_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_launch_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_launch_attestations_tenant ON industry.guest_launch_attestations FOR ALL
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON industry.guest_launch_attestations TO industry_app;

CREATE OR REPLACE FUNCTION industry.reject_guest_launch_attestation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Launch attestation history is append-only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER guest_launch_attestation_immutable
  BEFORE UPDATE OR DELETE ON industry.guest_launch_attestations
  FOR EACH ROW EXECUTE FUNCTION industry.reject_guest_launch_attestation_mutation();
