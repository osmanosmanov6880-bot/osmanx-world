-- R11: append-only, tenant-scoped task history for transparent first-pilot operations.
-- Backfill is explicitly an imported baseline, NEVER invented historical transitions.
CREATE TABLE industry.guest_action_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  pilot_id uuid NOT NULL,
  action_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES industry.accounts(id),
  event_type varchar(20) NOT NULL
    CHECK(event_type IN ('baseline','created','status','assignment')),
  from_status varchar(16) CHECK(from_status IN ('open','in_progress','done','dismissed')),
  to_status varchar(16) NOT NULL CHECK(to_status IN ('open','in_progress','done','dismissed')),
  previous_assignee uuid REFERENCES industry.accounts(id),
  next_assignee uuid NOT NULL REFERENCES industry.accounts(id),
  previous_due_on date,
  next_due_on date NOT NULL,
  action_version integer NOT NULL CHECK(action_version>=1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,pilot_id) REFERENCES industry.guest_pilots(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,action_id) REFERENCES industry.guest_actions(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(tenant_id,action_id,action_version)
);
CREATE INDEX guest_action_history_order_idx
  ON industry.guest_action_history(tenant_id,pilot_id,action_id,action_version ASC);

ALTER TABLE industry.guest_action_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.guest_action_history FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_action_history_tenant ON industry.guest_action_history FOR ALL
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON industry.guest_action_history TO industry_app;

CREATE OR REPLACE FUNCTION industry.reject_guest_action_history_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Guest action history is append-only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER guest_action_history_append_only
  BEFORE UPDATE OR DELETE ON industry.guest_action_history
  FOR EACH ROW EXECUTE FUNCTION industry.reject_guest_action_history_change();

-- Migration of R9 actions records only the current state as a baseline.
-- A baseline says nothing about the unknown earlier sequence of changes.
INSERT INTO industry.guest_action_history
  (tenant_id,pilot_id,action_id,actor_id,event_type,from_status,to_status,
   previous_assignee,next_assignee,previous_due_on,next_due_on,action_version,recorded_at)
SELECT a.tenant_id,a.pilot_id,a.id,a.created_by,'baseline',NULL,a.status,
       NULL,a.assigned_to,NULL,a.due_on,a.version,a.updated_at
FROM industry.guest_actions a;
