# OSMANX CINEMA R8 — verified operations, bounded exports and staging

## Implemented in five blocks

1. **Runtime truth** — the public \`GET /cinema/public/runtime\` identifies the actually deployed API release, whether public intake/anonymous actions are enabled, and the supported operator features. The mobile dashboard disables R8 operations when the new API is not responding, rather than suggesting an HTML-only deployment is a working CRM.
2. **Owner CSV authorization** — R8 requires owner role, a POST with CSRF and an explicit confirmation for each 1–100 lead IDs. The server verifies every ID belongs to the current operator tenant, then writes a PII-free \`bulk_export_authorized\` access receipt. The browser only generates loaded-record CSV after approval of *all* batches (maximum 500 rows per action). Unauthorized, deleted or foreign-tenant IDs fail closed. The receipt is of **authorization**, not proof that the file was downloaded.
3. **Retention evidence** — migration 017 adds \`industry.cinema_retention_runs\` with forced RLS. Each actual tenant sweep inserts a record of deletion counts **inside the same transaction**, even when zero records were removed. If insertion fails, the sweep rolls back. Old receipts expire after 180 days; customer records keep their existing 90-day retention window. An observed past run **does not prove** the cron timer is scheduled.
4. **Owner preflight dashboard** — owner-only \`GET /cinema/ops/preflight\` gives the total/expired lead count, latest execution receipt, and deterministic states (not observed, recent, stale, review). The mobile UI never shows this data to a manager.
5. **Operator staging gate and acceptance** — \`cinema:r8:readiness\` checks existing R7 prerequisites, migration 017 constraint/forced RLS, recent tenant-specific retention execution, exact digest-pinned image and manual operator approval. \`cinema:r8:canary\` only probes a loopback HTTP staging origin, verifies the R8 feature contract, expects public writes and anonymous sensitive reads to fail closed, and never sends customer data. PostgreSQL 16 tests and Chromium phone/desktop exercise both R8 and the R7 fallback.

## Release is NO-GO until independent operator checks

1. Confirm the legal data controller, correct privacy notice, legitimate basis for processing and the mailbox receiving contact requests.
2. Build a reviewed Industry API container from a particular Git SHA. Record the immutable image SHA-256; avoid mutable image tags.
3. Back up the staging PostgreSQL database and restore it to an isolated environment. Run migrations up to **017** and repeat for idempotency.
4. Create only synthetic, consented test leads in the isolated staging tenant. Verify owner and manager access boundaries; approve one export; verify receipt without customer email; perform retention on test rows and check one execution record.
5. Verify both CINEMA_PUBLIC_WRITE_ENABLED=false and CINEMA_AGGREGATE_EVENTS_ENABLED=false. Record independent backup/restore, timer and staff reviews. Do not set approval flags merely to satisfy a CI test.
6. Set CINEMA_R8_OPERATOR_REVIEWED=true and CINEMA_R8_IMAGE_DIGEST=sha256:<64_hex> **only after checking the evidence**. Run \`npm run cinema:r8:readiness\` with limited RLS credentials.
7. Start the API in isolated staging on localhost. Run \`npm run cinema:r8:canary\` with CINEMA_R8_STAGING_URL set to a loopback HTTP origin. Do not pass the public domain or customer data to this script.
8. Once operator checks have completed, separately deploy the API and its migration behind verified TLS, then test one synthetic customer journey and delete it. Only a distinct authorized release can enable public intake.

## Safety boundaries

- Static GitHub publishing **does not** deploy API containers, apply database migrations or activate data collection.
- CSV export permissions limit the **provided UI**. A staff member legitimately authorized to view records can still copy visible data; enforce organizational policy and audit access accordingly.
- The latest retention receipt records a real past database sweep but does not verify the future timer, lawful processing or backup integrity.
- No calls, WhatsApp messages, email messages or payments are performed by these workflows.
- No fake revenues, unique visitor counts or cryptographic audit assertions are generated.
- Where the server is still R7, the R8 CSV button remains disabled, while the existing R6/R7 list continues to work.

Related: CINEMA_R7_RUNBOOK.md, CINEMA_R6_ACCEPTANCE.md and CINEMA_R5_ACCEPTANCE.md.
