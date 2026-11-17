-- OSMANX Industry OS R7 scheduling policy.
ALTER TABLE industry.resources
  ADD COLUMN slot_interval_minutes smallint NOT NULL DEFAULT 30
    CHECK (slot_interval_minutes IN (15,30,60)),
  ADD COLUMN buffer_minutes smallint NOT NULL DEFAULT 0
    CHECK (buffer_minutes BETWEEN 0 AND 120 AND buffer_minutes % 5 = 0);

CREATE TABLE industry.resource_closed_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  closed_date date NOT NULL,
  reason varchar(160) NOT NULL DEFAULT 'Закрыто',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,resource_id,closed_date),
  FOREIGN KEY (tenant_id,resource_id) REFERENCES industry.resources(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX resource_closed_dates_lookup ON industry.resource_closed_dates(tenant_id,resource_id,closed_date);
ALTER TABLE industry.resource_closed_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry.resource_closed_dates FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_closed_dates_tenant ON industry.resource_closed_dates FOR ALL
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON industry.resource_closed_dates TO industry_app;
