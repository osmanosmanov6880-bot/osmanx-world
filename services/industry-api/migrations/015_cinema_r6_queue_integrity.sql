-- CINEMA R6: transaction-safe contact replay and privacy access receipts.
-- No cookie IDs, message bodies or new public tables.
ALTER TABLE industry.cinema_lead_events
  ADD COLUMN contact_request_key varchar(80),
  ADD COLUMN contact_request_digest char(64),
  ADD CONSTRAINT cinema_r6_contact_key_pair CHECK (
    (contact_request_key IS NULL) = (contact_request_digest IS NULL)
  ),
  ADD CONSTRAINT cinema_r6_contact_key_shape CHECK (
    contact_request_key IS NULL OR (
      event_type='contact_logged'
      AND contact_request_key ~ '^[a-zA-Z0-9._:-]{16,80}$'
      AND contact_request_digest ~ '^[0-9a-f]{64}$'
    )
  );
CREATE UNIQUE INDEX cinema_r6_contact_idempotency_idx
  ON industry.cinema_lead_events(tenant_id,lead_id,contact_request_key)
  WHERE contact_request_key IS NOT NULL;

CREATE TABLE industry.cinema_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES industry.tenants(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES industry.accounts(id) ON DELETE SET NULL,
  lead_id uuid,
  action varchar(24) NOT NULL
    CHECK(action IN ('subject_search','subject_export','lead_deleted')),
  result_count integer NOT NULL DEFAULT 0 CHECK(result_count>=0 AND result_count<=1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,lead_id) REFERENCES industry.cinema_leads(tenant_id,id)
    ON DELETE SET NULL (lead_id)
);
CREATE INDEX cinema_r6_access_recent_idx
  ON industry.cinema_access_events(tenant_id,created_at DESC,id DESC);
ALTER TABLE industry.cinema_access_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.cinema_access_events FORCE ROW LEVEL SECURITY;
CREATE POLICY cinema_access_tenant ON industry.cinema_access_events FOR ALL
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,DELETE ON industry.cinema_access_events TO industry_app;

-- Contact and subject-access events contain no free-text identifiers.
-- Deleting a lead unlinks any remaining access receipts from its UUID.
