-- OSMANX CINEMA R4 — robust follow-ups, honest campaign attribution, privacy-safe audit.
-- Additive to migration 012. No existing personal data is rewritten.
ALTER TABLE industry.cinema_leads
  ADD COLUMN campaign_code varchar(40) NOT NULL DEFAULT 'direct'
    CHECK (campaign_code ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  ADD COLUMN next_action_at timestamptz,
  ADD COLUMN next_action_kind varchar(20)
    CHECK (next_action_kind IN ('call','email','proposal','review')),
  ADD COLUMN loss_reason_code varchar(24)
    CHECK (loss_reason_code IN ('price','timing','competitor','no_response','out_of_scope','other')),
  ADD CONSTRAINT cinema_leads_next_action_pair CHECK
    ((next_action_at IS NULL) = (next_action_kind IS NULL)),
  ADD CONSTRAINT cinema_leads_closed_followup CHECK
    (state NOT IN ('won','lost') OR next_action_at IS NULL),
  ADD CONSTRAINT cinema_leads_loss_state CHECK
    (loss_reason_code IS NULL OR state='lost');

CREATE INDEX cinema_leads_followup_idx
  ON industry.cinema_leads(tenant_id,next_action_at,id)
  WHERE next_action_at IS NOT NULL AND state NOT IN ('won','lost');
CREATE INDEX cinema_leads_campaign_idx
  ON industry.cinema_leads(tenant_id,campaign_code,created_at DESC);

ALTER TABLE industry.cinema_lead_events
  DROP CONSTRAINT cinema_lead_events_event_type_check,
  ADD CONSTRAINT cinema_lead_events_event_type_check
    CHECK(event_type IN ('created','state_changed','value_changed','followup_changed','outcome_coded')),
  ADD COLUMN next_action_at timestamptz,
  ADD COLUMN next_action_kind varchar(20),
  ADD COLUMN loss_reason_code varchar(24);

ALTER TABLE industry.cinema_daily_events
  ADD COLUMN campaign_code varchar(40) NOT NULL DEFAULT 'direct'
    CHECK (campaign_code ~ '^[a-z0-9][a-z0-9_-]{0,39}$');
ALTER TABLE industry.cinema_daily_events
  DROP CONSTRAINT cinema_daily_events_pkey,
  ADD PRIMARY KEY (tenant_id,date_utc,event_type,story_id,campaign_code);

-- Only the migration role may alter RLS; existing policies and grants remain in force.
-- No free-text notes on action history; no contact data in anonymous event counters.
