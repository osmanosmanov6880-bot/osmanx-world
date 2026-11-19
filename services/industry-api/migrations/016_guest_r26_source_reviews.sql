-- R26: two-role, append-only internal declarations about a bounded R25
-- tally snapshot. NOT an independent external audit or cryptographic signature.
-- Anchored to full R25 tally SHA, R24 evidence SHA and exact pilot version.
-- No source files, contact information or free-text evidence are stored.
CREATE TABLE industry.guest_r26_source_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  pilot_id uuid NOT NULL,
  pilot_version integer NOT NULL CHECK(pilot_version >= 1),
  tally_source_sha char(64) NOT NULL CHECK(tally_source_sha ~ '^[a-f0-9]{64}$'),
  r24_evidence_sha char(64) NOT NULL CHECK(r24_evidence_sha ~ '^[a-f0-9]{64}$'),
  tally_rows integer NOT NULL CHECK(tally_rows BETWEEN 1 AND 36),
  actor_id uuid NOT NULL REFERENCES industry.accounts(id),
  actor_role varchar(10) NOT NULL CHECK(actor_role IN ('owner','manager')),
  method varchar(40) NOT NULL CHECK(method IN
    ('staff_shift_crosscheck','anonymous_counter_audit',
     'independent_aggregate_recount')),
  verdict varchar(12) NOT NULL CHECK(verdict IN ('reconciled','rejected')),
  evidence_sha char(64) NOT NULL CHECK(evidence_sha ~ '^[a-f0-9]{64}$'),
  idempotency_key varchar(80) NOT NULL
    CHECK(idempotency_key ~ '^[A-Za-z0-9._:-]{8,80}$'),
  payload_digest char(64) NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,pilot_id)
    REFERENCES industry.guest_pilots(tenant_id,id),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,pilot_id,idempotency_key),
  -- One final declaration per role for the exact evidence snapshot.
  -- Any new tally or pilot version requires a different snapshot.
  UNIQUE(tenant_id,pilot_id,pilot_version,tally_source_sha,actor_role)
);
CREATE INDEX guest_r26_reviews_tenant_pilot_order
  ON industry.guest_r26_source_reviews(tenant_id,pilot_id,reviewed_at DESC,id);
ALTER TABLE industry.guest_r26_source_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_r26_source_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_r26_source_reviews_tenant
  ON industry.guest_r26_source_reviews FOR ALL TO industry_app
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON industry.guest_r26_source_reviews FROM PUBLIC;
GRANT SELECT,INSERT ON industry.guest_r26_source_reviews TO industry_app;
CREATE OR REPLACE FUNCTION industry.reject_guest_r26_review_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'R26 source review declarations are append-only'
    USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER guest_r26_source_reviews_immutable
  BEFORE UPDATE OR DELETE ON industry.guest_r26_source_reviews
  FOR EACH ROW EXECUTE FUNCTION industry.reject_guest_r26_review_change();
