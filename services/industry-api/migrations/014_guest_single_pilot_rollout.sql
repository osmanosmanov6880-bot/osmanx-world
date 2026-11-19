-- R19 one-customer pilot: bound and monotonic daily collection budget.
-- No guest names, contacts, receipts, signatures, contracts or consent texts.
-- Emergency R13 safety changes DO NOT spend daily slots.
CREATE TABLE industry.guest_r19_daily_usage (
  tenant_id uuid NOT NULL,
  pilot_id uuid NOT NULL,
  utc_day date NOT NULL,
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count BETWEEN 0 AND 100),
  max_daily integer NOT NULL CHECK (max_daily BETWEEN 1 AND 100),
  last_scope_sha char(64) NOT NULL CHECK (last_scope_sha ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,pilot_id,utc_day),
  FOREIGN KEY (tenant_id,pilot_id) REFERENCES industry.guest_pilots(tenant_id,id)
);
CREATE INDEX guest_r19_daily_usage_recent
  ON industry.guest_r19_daily_usage(tenant_id,utc_day DESC,pilot_id);
ALTER TABLE industry.guest_r19_daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_r19_daily_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_r19_daily_usage_tenant ON industry.guest_r19_daily_usage FOR ALL
  TO industry_app USING (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
  ) WITH CHECK (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
  );
REVOKE ALL ON industry.guest_r19_daily_usage FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE(used_count,max_daily,last_scope_sha,updated_at)
  ON industry.guest_r19_daily_usage TO industry_app;

CREATE OR REPLACE FUNCTION industry.guard_r19_usage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'R19 usage ledger cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.pilot_id<>OLD.pilot_id OR
     NEW.utc_day<>OLD.utc_day OR
     NEW.used_count<OLD.used_count OR
     NEW.max_daily>OLD.max_daily OR
     NEW.used_count>NEW.max_daily THEN
    RAISE EXCEPTION 'R19 daily usage rollback or quota increase forbidden'
      USING ERRCODE='23514';
  END IF;
  NEW.updated_at=now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_guest_r19_usage
  BEFORE UPDATE OR DELETE ON industry.guest_r19_daily_usage
  FOR EACH ROW EXECUTE FUNCTION industry.guard_r19_usage();

CREATE TABLE industry.guest_r19_collection_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  pilot_id uuid NOT NULL,
  kind varchar(20) NOT NULL CHECK(kind IN ('start','observations','observations/import')),
  utc_day date NOT NULL,
  scope_sha char(64) NOT NULL CHECK(scope_sha ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,pilot_id) REFERENCES industry.guest_pilots(tenant_id,id)
);
CREATE INDEX guest_r19_collection_events_recent
  ON industry.guest_r19_collection_events(tenant_id,pilot_id,recorded_at DESC);
ALTER TABLE industry.guest_r19_collection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_r19_collection_events FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_r19_collection_events_tenant ON industry.guest_r19_collection_events FOR ALL
  TO industry_app USING (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
  ) WITH CHECK (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
  );
REVOKE ALL ON industry.guest_r19_collection_events FROM PUBLIC;
GRANT SELECT,INSERT ON industry.guest_r19_collection_events TO industry_app;

CREATE OR REPLACE FUNCTION industry.reject_r19_collection_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'R19 collection events are append-only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER guest_r19_collection_events_immutable
  BEFORE UPDATE OR DELETE ON industry.guest_r19_collection_events
  FOR EACH ROW EXECUTE FUNCTION industry.reject_r19_collection_change();
