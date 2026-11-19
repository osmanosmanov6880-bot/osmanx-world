-- R18: separate checkpoint for external third-party signed receipts.
-- Advances in the SAME transaction as a Guest write. An external custodian
-- key and independent minimum sequence still have to be pinned outside DB.
CREATE TABLE industry.guest_external_anchor_fence (
  id smallint PRIMARY KEY CHECK(id=1),
  max_revision bigint NOT NULL DEFAULT 0 CHECK(max_revision>=0),
  max_sequence bigint NOT NULL DEFAULT 0 CHECK(max_sequence>=0),
  checkpoint_sha char(64) NOT NULL DEFAULT repeat('0',64)
    CHECK(checkpoint_sha ~ '^[a-f0-9]{64}$'),
  anchor_sha char(64) NOT NULL DEFAULT repeat('0',64)
    CHECK(anchor_sha ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guest_external_anchor_fence_consistency CHECK (
    (max_revision=0 AND max_sequence=0) OR
    (max_revision>0 AND max_sequence>0)
  )
);
INSERT INTO industry.guest_external_anchor_fence(id) VALUES(1);
REVOKE ALL ON industry.guest_external_anchor_fence FROM PUBLIC;
GRANT SELECT,UPDATE(max_revision,max_sequence,checkpoint_sha,anchor_sha,updated_at)
  ON industry.guest_external_anchor_fence TO industry_app;
ALTER TABLE industry.guest_external_anchor_fence ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_external_anchor_fence FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_external_anchor_fence_read ON industry.guest_external_anchor_fence
  FOR SELECT TO industry_app USING(true);
CREATE POLICY guest_external_anchor_fence_advance ON industry.guest_external_anchor_fence
  FOR UPDATE TO industry_app USING(true) WITH CHECK(true);

CREATE OR REPLACE FUNCTION industry.guard_external_anchor_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'External anchor fence cannot be removed' USING ERRCODE='23514';
  END IF;
  IF NEW.max_revision < OLD.max_revision OR
     NEW.max_sequence < OLD.max_sequence OR
     (NEW.max_sequence=OLD.max_sequence AND
       (NEW.max_revision<>OLD.max_revision OR
        NEW.checkpoint_sha<>OLD.checkpoint_sha OR
        NEW.anchor_sha<>OLD.anchor_sha)) THEN
    RAISE EXCEPTION 'External anchor rollback forbidden' USING ERRCODE='23514';
  END IF;
  IF NEW.max_sequence>OLD.max_sequence AND NEW.max_revision<=0 THEN
    RAISE EXCEPTION 'Invalid external anchor transition' USING ERRCODE='23514';
  END IF;
  NEW.updated_at=now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER guest_external_anchor_guard
  BEFORE UPDATE OR DELETE ON industry.guest_external_anchor_fence
  FOR EACH ROW EXECUTE FUNCTION industry.guard_external_anchor_fence();

CREATE TABLE industry.guest_external_anchor_receipts (
  journal_sequence bigint PRIMARY KEY CHECK(journal_sequence>0),
  registry_revision bigint NOT NULL CHECK(registry_revision>0),
  checkpoint_sha char(64) NOT NULL CHECK(checkpoint_sha ~ '^[a-f0-9]{64}$'),
  anchor_sha char(64) NOT NULL CHECK(anchor_sha ~ '^[a-f0-9]{64}$'),
  accepted_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON industry.guest_external_anchor_receipts FROM PUBLIC;
GRANT SELECT,INSERT ON industry.guest_external_anchor_receipts TO industry_app;
ALTER TABLE industry.guest_external_anchor_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_external_anchor_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_external_receipts_read ON industry.guest_external_anchor_receipts
  FOR SELECT TO industry_app USING(true);
CREATE POLICY guest_external_receipts_append ON industry.guest_external_anchor_receipts
  FOR INSERT TO industry_app WITH CHECK(true);

CREATE OR REPLACE FUNCTION industry.prevent_external_receipt_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'External anchor receipts are append-only'
    USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER guest_external_receipts_immutable
  BEFORE UPDATE OR DELETE ON industry.guest_external_anchor_receipts
  FOR EACH ROW EXECUTE FUNCTION industry.prevent_external_receipt_rewrite();
