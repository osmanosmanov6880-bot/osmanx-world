-- CINEMA R8: owner export receipts and verifiable retention runs.
-- No emails, phone numbers, names or message bodies are stored in receipts.
ALTER TABLE industry.cinema_access_events
  DROP CONSTRAINT cinema_access_events_action_check,
  ADD CONSTRAINT cinema_access_events_action_check
    CHECK (action IN ('subject_search','subject_export','lead_deleted','bulk_export_authorized'));

CREATE TABLE industry.cinema_retention_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  erased_leads integer NOT NULL CHECK(erased_leads>=0),
  expired_metrics integer NOT NULL CHECK(expired_metrics>=0),
  expired_rate_buckets integer NOT NULL CHECK(expired_rate_buckets>=0),
  expired_access_receipts integer NOT NULL CHECK(expired_access_receipts>=0),
  executed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cinema_retention_runs_by_tenant
  ON industry.cinema_retention_runs(tenant_id,executed_at DESC,id DESC);
ALTER TABLE industry.cinema_retention_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.cinema_retention_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY cinema_retention_runs_tenant ON industry.cinema_retention_runs FOR ALL
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,DELETE ON industry.cinema_retention_runs TO industry_app;

-- Metadata receipts themselves expire after 180 days in the same tenant-bound sweep.
-- The presence of a receipt is not proof that a scheduler exists or will run tomorrow.
