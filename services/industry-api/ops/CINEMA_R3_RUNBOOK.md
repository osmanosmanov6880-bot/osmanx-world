# OSMANX CINEMA R3 — operator release gate

## Five commercial blocks
1. PostgreSQL tenant-scoped lead records with RLS, immutable status history, consent timestamps, idempotency and retention.
2. Backend public intake behind explicit flag, email-hash/global rate limits, role-protected sales stages and metrics.
3. Consent-first CINEMA: diagnostic brief, contact information, safe submission, or mailto fallback if API unavailable.
4. Protected manager at /assets/stories/manager.html with account sessions, CSRF, stage/version control and safe CSV export.
5. First-party anonymous action counters and unit/Chromium/PostgreSQL/HTTPS regression gates.

## Critical separation: static publication != API activation
The static site deploy syncs assets only. It DOES NOT apply migrations or deploy the Industry API. Online intake MUST remain off until backend staging and operator approval. The public page must show an email fallback while disabled.

Required production environment (set privately, not in git):
- CINEMA_PUBLIC_WRITE_ENABLED=false (default)
- CINEMA_AGGREGATE_EVENTS_ENABLED=false (default)
- CINEMA_TENANT_ID=<UUID of a dedicated OSMANX operator tenant>
- CINEMA_RATE_SECRET=<unique secret of at least 32 characters>

## Safe activation checklist
1. Verify operator legal identity and that hello@osmanx.world is actually monitored. Update /assets/stories/privacy.html with legally required controller information and applicable notices BEFORE collecting personal data.
2. Deploy revised Industry API to isolated staging behind HTTPS reverse proxy; keep PostgreSQL private.
3. Migrate with the migration role. Verify 012_cinema_commercial.sql is applied once; rerun to confirm idempotency.
4. Verify RLS with a foreign tenant. Confirm owner/manager membership in the configured operator tenant, not a customer tenant.
5. Confirm CI PostgreSQL and mobile/desktop Chromium checks pass, including consent, rate limit, idempotency, audit history, wrong-tenant access and erasure.
6. Configure monitored daily cleanup: leads older than 90 days, event aggregates older than 180 days and rate buckets older than 48 hours. Owner-only retention endpoint exists but is NOT an automatic scheduler.
7. Test anonymous events on staging; these are action totals, NOT unique visitors or proven conversion rates.
8. Deploy API to the intended environment. Set CINEMA_TENANT_ID and CINEMA_RATE_SECRET privately. Enable public writes ONLY after staging acceptance and legal readiness.
9. Submit one synthetic, explicitly consented test lead over HTTPS; verify receipt in protected manager, stage update and deletion.
10. Rollback: turn CINEMA_PUBLIC_WRITE_ENABLED=false, restart API, verify public config shows intakeEnabled=false and email fallback works. Never delete production tables during rollback.

## Important protected endpoints
- GET /api/industry/v1/cinema/leads?limit=100 — owner/manager queue for the configured tenant
- GET /api/industry/v1/cinema/metrics — stage counts, manually entered values, anonymous actions
- PATCH /api/industry/v1/cinema/leads/:id — optimistic versioned pipeline
- GET /api/industry/v1/cinema/leads/:id/history — stage audit events
- DELETE /api/industry/v1/cinema/leads/:id — owner-only erasure
- POST /api/industry/v1/cinema/retention with {"confirm":"ERASE_EXPIRED"} — owner-only manual cleanup

Neither a 'won' stage nor an estimate proves a payment was received. No unverified checkout or payment product is automatically created.

Public pages after static release:
- https://osmanx.world/assets/stories/cinema.html
- https://osmanx.world/assets/stories/privacy.html
- https://osmanx.world/assets/stories/manager.html
- https://osmanx.world/assets/guest/order.html?plan=pilot
