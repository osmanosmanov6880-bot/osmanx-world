-- OSMANX CINEMA R5: staff assignments, contact attempt evidence, no free-text PII.
-- Existing RLS remains forced. Tables inherit the operator tenant boundary.
ALTER TABLE industry.cinema_leads
  ADD COLUMN assigned_to uuid,
  ADD COLUMN first_contact_at timestamptz,
  ADD COLUMN last_contact_at timestamptz,
  ADD COLUMN contact_count integer NOT NULL DEFAULT 0 CHECK(contact_count>=0),
  ADD CONSTRAINT cinema_leads_contact_times_check CHECK(
    first_contact_at IS NULL OR (last_contact_at IS NOT NULL AND first_contact_at<=last_contact_at)
  ),
  ADD CONSTRAINT cinema_leads_assignment_membership_fk
    FOREIGN KEY (tenant_id,assigned_to)
    REFERENCES industry.memberships(tenant_id,account_id) ON DELETE SET NULL (assigned_to);
CREATE INDEX cinema_leads_assignee_state_idx
  ON industry.cinema_leads(tenant_id,assigned_to,state,next_action_at)
  WHERE state NOT IN ('won','lost');

ALTER TABLE industry.cinema_lead_events
  DROP CONSTRAINT cinema_lead_events_event_type_check,
  ADD CONSTRAINT cinema_lead_events_event_type_check
    CHECK(event_type IN ('created','state_changed','value_changed','followup_changed','outcome_coded','assigned_changed','contact_logged')),
  ADD COLUMN assigned_to uuid,
  ADD COLUMN contact_channel varchar(16) CHECK(contact_channel IN ('email','phone','whatsapp','in_person')),
  ADD COLUMN contact_outcome varchar(20) CHECK(contact_outcome IN ('attempted','connected','no_reply','invalid_contact')),
  ADD CONSTRAINT cinema_contact_event_fields_pair CHECK(
    (contact_channel IS NULL)=(contact_outcome IS NULL)
  ),
  ADD CONSTRAINT cinema_contact_event_type_check CHECK(
    (event_type='contact_logged')=(contact_channel IS NOT NULL)
  );

-- RLS from migration 012 applies to newly added columns, no new public grants.
-- No phone numbers, message bodies or third-party customer information are stored.
