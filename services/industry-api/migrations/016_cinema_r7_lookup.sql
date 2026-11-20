-- CINEMA R7: exact-email operator-assisted duplicate investigation.
-- Index resides behind existing cinema_leads tenant RLS; no new person records.
CREATE INDEX cinema_r7_tenant_email_lookup_idx
  ON industry.cinema_leads(tenant_id, lower(contact_email), created_at DESC, id DESC);
