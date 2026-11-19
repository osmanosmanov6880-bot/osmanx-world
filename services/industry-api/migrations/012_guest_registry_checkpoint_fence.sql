-- R17: global non-PII high-water fence, updated in the SAME transaction as a
-- guest mutation. Database survives Node process restart and R16 file rollback.
-- Only the non-privileged industry_app can compare/advance the checkpoint.
-- No tenant records, customer names, or private keys are stored here.
CREATE TABLE industry.guest_registry_checkpoint_fence (
  id smallint PRIMARY KEY CHECK(id=1),
  max_revision bigint NOT NULL DEFAULT 0 CHECK(max_revision>=0),
  max_sequence bigint NOT NULL DEFAULT 0 CHECK(max_sequence>=0),
  checkpoint_sha char(64) NOT NULL DEFAULT repeat('0',64)
    CHECK(checkpoint_sha ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guest_fence_consistency CHECK (
    (max_sequence=0 AND max_revision=0) OR
    (max_sequence>0 AND max_revision>0)
  )
);
INSERT INTO industry.guest_registry_checkpoint_fence(id) VALUES(1);
REVOKE ALL ON industry.guest_registry_checkpoint_fence FROM PUBLIC;
GRANT SELECT,UPDATE(max_revision,max_sequence,checkpoint_sha,updated_at)
  ON industry.guest_registry_checkpoint_fence TO industry_app;
ALTER TABLE industry.guest_registry_checkpoint_fence ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_registry_checkpoint_fence FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_registry_fence_read ON industry.guest_registry_checkpoint_fence
  FOR SELECT TO industry_app USING(true);
CREATE POLICY guest_registry_fence_advance ON industry.guest_registry_checkpoint_fence
  FOR UPDATE TO industry_app USING(true) WITH CHECK(true);

CREATE OR REPLACE FUNCTION industry.guest_registry_fence_monotonic()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Guest registry checkpoint cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF NEW.max_revision < OLD.max_revision OR
     NEW.max_sequence < OLD.max_sequence OR
     (NEW.max_sequence=OLD.max_sequence AND
       (NEW.max_revision<>OLD.max_revision OR NEW.checkpoint_sha<>OLD.checkpoint_sha)) THEN
    RAISE EXCEPTION 'Guest registry checkpoint rollback forbidden' USING ERRCODE='23514';
  END IF;
  IF NEW.max_sequence>OLD.max_sequence AND NEW.max_revision=0 THEN
    RAISE EXCEPTION 'Invalid guest registry fence transition' USING ERRCODE='23514';
  END IF;
  NEW.updated_at=now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER guest_registry_fence_monotonic_update
  BEFORE UPDATE OR DELETE ON industry.guest_registry_checkpoint_fence
  FOR EACH ROW EXECUTE FUNCTION industry.guest_registry_fence_monotonic();
