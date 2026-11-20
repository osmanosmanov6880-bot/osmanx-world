-- CINEMA R9: distinguish generated owner exports from earlier permission checks.
-- Remains tenant-RLS protected and stores NO CSV, name, email or customer body.
ALTER TABLE industry.cinema_access_events
  DROP CONSTRAINT cinema_access_events_action_check,
  ADD CONSTRAINT cinema_access_events_action_check CHECK(
    action IN ('subject_search','subject_export','lead_deleted',
      'bulk_export_authorized','bulk_export_generated')
  );

-- Accelerate exact evidence of the first manually registered contact.
-- No separate unbounded copy of customer PII is created.
CREATE INDEX cinema_r9_contact_first_event_idx
  ON industry.cinema_lead_events(tenant_id,lead_id,occurred_at)
  WHERE event_type='contact_logged';
