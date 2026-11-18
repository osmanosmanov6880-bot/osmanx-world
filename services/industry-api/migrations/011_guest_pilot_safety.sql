-- R13 safety circuit-breaker. Active pause is separate from pilot phase and from
-- protocol/evidence.v1/v2, so restores retain all original published evidence.
CREATE TABLE industry.guest_pilot_holds (
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  pilot_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  reason_code varchar(32) NOT NULL CHECK(reason_code IN
    ('source_integrity','consent_review','data_quality','operational_incident')),
  held_by uuid NOT NULL REFERENCES industry.accounts(id),
  held_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES industry.accounts(id),
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK(version>=1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,pilot_id),
  FOREIGN KEY(tenant_id,pilot_id) REFERENCES industry.guest_pilots(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT guest_pilot_hold_consistency CHECK (
    (active AND resolved_by IS NULL AND resolved_at IS NULL) OR
    (NOT active AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  )
);
CREATE INDEX guest_pilot_holds_active_idx
  ON industry.guest_pilot_holds(tenant_id,updated_at DESC)
  WHERE active;

CREATE TABLE industry.guest_pilot_hold_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  pilot_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES industry.accounts(id),
  event_type varchar(16) NOT NULL CHECK(event_type IN ('held','resumed')),
  reason_code varchar(32) NOT NULL CHECK(reason_code IN
    ('source_integrity','consent_review','data_quality','operational_incident')),
  hold_version integer NOT NULL CHECK(hold_version>=1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,pilot_id) REFERENCES industry.guest_pilots(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(tenant_id,pilot_id,hold_version)
);
CREATE INDEX guest_pilot_hold_events_order_idx
  ON industry.guest_pilot_hold_events(tenant_id,pilot_id,hold_version);

ALTER TABLE industry.guest_pilot_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_pilot_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_pilot_holds_tenant ON industry.guest_pilot_holds FOR ALL
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE industry.guest_pilot_hold_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_pilot_hold_events FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_pilot_hold_events_tenant ON industry.guest_pilot_hold_events FOR ALL
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT,INSERT,UPDATE ON industry.guest_pilot_holds TO industry_app;
GRANT SELECT,INSERT ON industry.guest_pilot_hold_events TO industry_app;

CREATE OR REPLACE FUNCTION industry.reject_guest_pilot_hold_event_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Pilot safety events are append-only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER guest_pilot_hold_events_append_only
  BEFORE UPDATE OR DELETE ON industry.guest_pilot_hold_events
  FOR EACH ROW EXECUTE FUNCTION industry.reject_guest_pilot_hold_event_change();

-- A live pilot cannot be deleted through safety controls; safety event history
-- follows the same tenant-scoped lifecycle as its parent pilot.
