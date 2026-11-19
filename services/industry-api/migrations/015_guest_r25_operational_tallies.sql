-- R25 anonymous, mutually exclusive shift-level barrier observations.
-- STAFF ESTIMATES are NOT real guest motives and must never be sold as such.
-- No name, phone, email, device, free text, session or personal identifier.
-- Existing R19 single-pilot quota covers each successful tally transaction.
ALTER TABLE industry.guest_r19_collection_events
  DROP CONSTRAINT guest_r19_collection_events_kind_check;
ALTER TABLE industry.guest_r19_collection_events
  ADD CONSTRAINT guest_r19_collection_events_kind_check
  CHECK(kind IN ('start','observations','observations/import','operational-signals'));

CREATE TABLE industry.guest_r25_operational_tallies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  pilot_id uuid NOT NULL,
  observed_on date NOT NULL,
  shift varchar(12) NOT NULL CHECK(shift IN ('morning','afternoon','evening')),
  source_kind varchar(20) NOT NULL
    CHECK(source_kind IN ('staff_estimate','anonymous_counter')),
  sampled integer NOT NULL CHECK(sampled BETWEEN 10 AND 10000),
  wait_count integer NOT NULL CHECK(wait_count BETWEEN 0 AND 10000),
  stockout_count integer NOT NULL CHECK(stockout_count BETWEEN 0 AND 10000),
  ordering_count integer NOT NULL CHECK(ordering_count BETWEEN 0 AND 10000),
  price_count integer NOT NULL CHECK(price_count BETWEEN 0 AND 10000),
  service_count integer NOT NULL CHECK(service_count BETWEEN 0 AND 10000),
  unknown_count integer NOT NULL CHECK(unknown_count BETWEEN 0 AND 10000),
  idempotency_key varchar(80) NOT NULL
    CHECK(idempotency_key ~ '^[A-Za-z0-9._:-]{8,80}$'),
  payload_digest char(64) NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  recorded_by uuid NOT NULL REFERENCES industry.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,pilot_id)
    REFERENCES industry.guest_pilots(tenant_id,id),
  CHECK(wait_count+stockout_count+ordering_count+price_count+
    service_count+unknown_count=sampled),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,pilot_id,idempotency_key),
  UNIQUE(tenant_id,pilot_id,observed_on,shift)
);
CREATE INDEX guest_r25_tallies_order_idx
  ON industry.guest_r25_operational_tallies
  (tenant_id,pilot_id,observed_on ASC,shift ASC);
ALTER TABLE industry.guest_r25_operational_tallies ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_r25_operational_tallies FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_r25_tallies_tenant ON industry.guest_r25_operational_tallies
  FOR ALL TO industry_app
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON industry.guest_r25_operational_tallies FROM PUBLIC;
GRANT SELECT,INSERT ON industry.guest_r25_operational_tallies TO industry_app;

-- In addition to least-privilege grants, physically forbid edits/erasure.
CREATE OR REPLACE FUNCTION industry.reject_guest_r25_tally_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'R25 aggregate tallies are append-only'
    USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER guest_r25_tallies_immutable
  BEFORE UPDATE OR DELETE ON industry.guest_r25_operational_tallies
  FOR EACH ROW EXECUTE FUNCTION industry.reject_guest_r25_tally_change();
