# OSMANX CINEMA R9 — transactional export & measurable response operations

## Five delivered modules

1. **Server-owned CSV snapshot:** \`POST /cinema/exports/csv\` requires an owner session, CSRF and an explicit \`GENERATE_CSV\` confirmation for 1–500 unique UUIDs. Selected rows are reread from PostgreSQL under tenant RLS and a share lock. The server rejects deleted, foreign or changed selections, constructs a UTF-8 CSV with spreadsheet-formula escaping, and writes a PII-free \`bulk_export_generated\` access receipt in the *same transaction*. The response body is sent only after successful commit and has no-store/no-cache and attachment headers. No customer row is cached in the audit table. Legacy R8 \`/exports/approve\` remains for old deployed clients but the new UI **does not** use it.
2. **Evidence-backed response velocity:** \`GET /cinema/ops/response-review?days=7|30|90\` reports a first *recorded attempt* from \`contact_logged\` events, percentages with explicit eligible denominators, claims marked \`connected\` by humans, unresolved past-due tasks and no-attempt cases. This is not proof of an actual conversation, unique viewer, booked revenue or advertising causality.
3. **Stale-write recovery:** HTTP 409 now presents an explicit conflict banner and an accessible button to fetch updated cards. No mutation is silently retried after an uncertain response, preventing double actions. The UI uses a dedicated R9 server contract, and keeps server CSV blocked on pre-R9 APIs.
4. **Mobile manager experience:** phone/desktop response cards, explicit API-version status, server-generated CSV downloads, no local CSV construction, stale-write recovery and a safe R8 fallback. The dashboard can show an API offline indicator without pretending the CRM is live.
5. **Readiness and reproducible acceptance:** Migration 018 adds export-generation audit action and a partial contact-event index; tenant RLS already covers these tables. R9 read-only readiness builds on R8 prerequisites, verifies migration 018 and independently recorded operator review. Loopback-only canary requires intake disabled and private report/CSV anonymous requests denied. PostgreSQL and Chromium tests exercise privacy, CSV escaping, metrics, version conflicts and R8 compatibility.

## NO-GO before real production API activation

- The existing GitHub deploy publishes **static files only**. Main does not run migration 018, start the Industry API, install systemd, configure HTTPS proxy or enable real customer collection.
- The protected operator tenant must be authorized and verified by a real controller, with a published correct privacy notice, monitored mailbox and documented lawful basis for processing.
- Restore a recent encrypted backup to a disposable PostgreSQL 16 instance. Apply migrations 012–018 and repeat for idempotency.
- Confirm cross-tenant RLS, owner-only exports and PII-free receipts, disabled staff, 409 conflict behavior and 500-row bound.
- Verify actual cron/timer operation against a disposable tenant; an old receipt is insufficient evidence.
- Record immutable API image digest, reviewed Git SHA, operator identity and independent approvals. Do not set flags to true only to satisfy a gate.
- Keep \`CINEMA_PUBLIC_WRITE_ENABLED=false\`, \`CINEMA_AGGREGATE_EVENTS_ENABLED=false\` and run \`npm run cinema:r9:readiness\`; exit code 2 means NO-GO.
- Run \`npm run cinema:r9:canary\` only against an isolated **loopback HTTP** staging instance. Do not pass a live domain, real client email or production cookie.
- Separately deploy the approved API image/migrations behind real TLS and simulate one consented test lead. Verify cleanup before any authorized public activation.

## Limits

- Server CSV uses a transactionally consistent *authorization + row selection* and captures a real database state. After the transaction, clients may change or delete records; the exported historical snapshot is not a live view.
- The audit receipt confirms that a CSV was **generated and committed**, not that the client saved it, viewed it or delivered it elsewhere.
- The first-attempt timestamp is taken from manually entered audit events. A missing event may reflect a workflow problem rather than a missed real-world call.
- No automatic outbound messaging, calls, payments or client tracking were introduced.
- The presence of the R9 runtime route does not establish legal consent, active backups or the ability to reach external users.
