-- Guest Intelligence R5: audited archival of reviewed evidence.
-- Append only; no DROP or destructive migration. All rows remain tenant scoped.
ALTER TABLE industry.guest_pilots
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by uuid REFERENCES industry.accounts(id),
  ADD COLUMN archive_reason varchar(160);
ALTER TABLE industry.guest_pilots
  ADD CONSTRAINT guest_archival_consistency CHECK (
    (phase='archived') =
    (archived_at IS NOT NULL AND archived_by IS NOT NULL AND archive_reason IS NOT NULL)
  );
-- Archive only a reviewed pilot through owner-only API; RLS policies remain unchanged.
-- Immutable observation and review records continue to be accessible for authorized auditors.
CREATE INDEX guest_pilots_archive_idx
  ON industry.guest_pilots(tenant_id,archived_at DESC)
  WHERE archived_at IS NOT NULL;
