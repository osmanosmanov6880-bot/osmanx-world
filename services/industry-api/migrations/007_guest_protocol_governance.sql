-- Guest Intelligence R8: frozen protocol, tenant quotas and minimal retention.
-- Legacy archived pilots stay readable; new HTTP pilots require a protocol.
ALTER TABLE industry.guest_pilots
  ADD COLUMN protocol jsonb,
  ADD COLUMN protocol_registered_at timestamptz;
ALTER TABLE industry.guest_pilots
  ADD CONSTRAINT guest_protocol_pair CHECK (
    (protocol IS NULL AND protocol_registered_at IS NULL) OR
    (protocol IS NOT NULL AND protocol_registered_at IS NOT NULL AND jsonb_typeof(protocol)='object')
  );

CREATE OR REPLACE FUNCTION industry.prevent_guest_protocol_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.protocol IS DISTINCT FROM NEW.protocol OR
     OLD.protocol_registered_at IS DISTINCT FROM NEW.protocol_registered_at THEN
    -- New protocols are supplied at INSERT, and never changed after creation.
    RAISE EXCEPTION 'Guest protocol is immutable once created' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guest_protocol_immutable BEFORE UPDATE ON industry.guest_pilots
  FOR EACH ROW EXECUTE FUNCTION industry.prevent_guest_protocol_mutation();

-- Global maximums can be lowered for a customer by a DBA; the app can read only.
-- The HTTP API locks by tenant before calculating rolling quota counts.
CREATE TABLE industry.guest_quotas (
  tenant_id uuid PRIMARY KEY REFERENCES industry.tenants(id) ON DELETE CASCADE,
  annual_request_limit integer NOT NULL DEFAULT 250
    CHECK(annual_request_limit BETWEEN 1 AND 100000),
  active_pilot_limit integer NOT NULL DEFAULT 50
    CHECK(active_pilot_limit BETWEEN 1 AND 10000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE industry.guest_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_quotas FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_quotas_tenant ON industry.guest_quotas FOR SELECT
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON industry.guest_quotas TO industry_app;

ALTER TABLE industry.guest_requests ADD COLUMN redacted_at timestamptz;
CREATE INDEX guest_request_retention_idx
  ON industry.guest_requests(tenant_id,updated_at)
  WHERE state='declined' AND redacted_at IS NULL;

-- Efficient non-PII owner dashboards across phases.
CREATE INDEX guest_pilots_phase_tenant_idx
  ON industry.guest_pilots(tenant_id,phase,created_at DESC);
