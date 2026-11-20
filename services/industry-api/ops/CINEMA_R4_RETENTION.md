# R4 server-controlled retention

These are **installation templates**, not evidence that production already has a timer.
The app-role retention CLI runs within the same tenant-limited PostgreSQL RLS context
as the owner-only manual API endpoint. Records expire after 90 days, aggregated
anonymous actions after 180 days, and rate counters after 48 hours. Lead event
history is removed with the lead.

## Operator installation (requires infrastructure change approval)

1. Confirm legal controller identity, privacy text and documented retention periods.
2. Back up the DB; verify encrypted restore in disposable staging before running deletions.
3. Apply migration 013, then verify CLI locally on synthetic expired rows.
4. Set CINEMA_TENANT_ID to the dedicated **operator** tenant UUID. Do not use a customer tenant.
5. Set CINEMA_RETENTION_ENABLED=true in /etc/osmanx/industry.env (chmod 600).
6. Confirm WorkingDirectory and docker compose binary path in the service template.
7. Install service + timer in /etc/systemd/system, run systemctl daemon-reload,
   enable --now osmanx-cinema-retention.timer, inspect systemctl list-timers.
8. Run one approved manual instance and check summary counts, exit status and
   application logs. The output contains counts only; no contact information.
9. Alert on non-zero exit codes. A transaction-scoped advisory lock prevents overlapping runs.
10. On incident, disable the timer while investigating; do NOT turn off retention
    just because the public intake flag was rolled back.

CLI fails closed unless required private parameters exist. The normal website
deployment does NOT install or enable the timer or deploy the API container.
