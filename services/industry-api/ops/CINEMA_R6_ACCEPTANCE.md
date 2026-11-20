# OSMANX CINEMA R6 — five-block operational acceptance

## What R6 actually changes

1. **Explainable response risk**: overdue next actions, missing assignee and no registered contact within 24 hours are visible as separate facts. No predictive AI is used. Signals can overlap and are not proof of sales loss.
2. **Full work queue**: `GET /cinema/queue` uses PostgreSQL keyset pagination ordered by `(created_at,id)`, explicit view/state/assignee filters, page size 1–100 and a full count. `/queue/summary` counts active/overdue/unassigned/uncontacted globally, not just in a 100-row sample. The manager browser can load additional pages and exports ONLY displayed loaded rows to CSV. Filtering while the R6 backend is absent falls back to R5 without falsely claiming full coverage.
3. **Retry-safe contact activity**: optional `Idempotency-Key` header for compatibility with pre-R6 clients; the R6 UI always sets a cryptographically random key and reuses it for the same pending request after a network error. Transaction row locks serialize updates; a replay with the same payload returns the prior result without adding a second event, while key reuse with changed payload yields 409. Legacy clients without keys remain subject to version conflict checks.
4. **Subject access history**: owner-only exact-email search and JSON export now create RLS-bound access receipts that do not contain email or message bodies. Deletion receipts omit the lead UUID; deleting a lead also unlinks previous receipts from that UUID. Individual JSON export paginates by event version, 1000 at a time, and the browser refuses to label a truncated export complete. Access receipts are deleted after 90 days.
5. **Read-only release gate + tests**: migration 015, RLS on access receipts, unique replay keys, operator attestations, real PostgreSQL and mobile/desktop Chromium regression. `npm run cinema:r6:readiness` checks readiness; it does not activate collection.

## Mandatory NO-GO

**Merging to `main` deploys static HTML/CSS/JS only.** It does not install migration 015, deploy the Industry API, verify a real account, install a cron timer or turn on data collection. Do not present the real CRM as operational until the following operator checks are evidenced.

- Verify the data controller's identity, monitored email, legal basis/consent notice and staff access policy.
- Build the Industry API with the approved source revision; in isolated staging, run `npm run migrate` twice, verify migration 015 and `npm test` with real PostgreSQL.
- Verify cross-tenant RLS, disabled users, second-manager conflict, key collision vs repeat, pagination across >100 records and old R5 client compatibility.
- Verify a synthetic subject access search, a multi-page subject export and owner deletion with PII-free audit receipts.
- Back up the database, restore into a disposable environment, verify the daily retention timer still runs when public intake is disabled, and confirm the audit receipt 90-day retention.
- Document the independent approvals and timestamps for legal identity, mailbox operation, encrypted restore, retention and R5/R6 staff controls.
- Run the read-only R6 gate using least-privilege credentials. Keep `CINEMA_PUBLIC_WRITE_ENABLED=false` until a distinct authorized person approves staged activation.

After permission is granted, deploy the API container behind HTTPS, then perform one **synthetic consented** end-to-end customer journey; monitor error rates and roll back by disabling public intake if anything fails. The static page retains its email fallback.

### Known limits, stated explicitly

- No real WhatsApp, email, or telephone messages are sent by contact logging.
- The source of a campaign is a tagged URL; it is not proof that advertising caused a sale.
- `won` is a manually agreed opportunity, not cleared revenue.
- The queue's 24-hour signal is a transparent heuristic, not a contractual service level.
- The access-log view shows 100 recent operations per request, not a certified complete legal audit.
- The browser refuses to deliver an incomplete subject history if it exceeds its bounded pagination or encounters an older backend.
- Human identity verification occurs **outside the software**. A checkbox is only an operator acknowledgement.

Reference: `CINEMA_R3_RUNBOOK.md`, `CINEMA_R4_RETENTION.md`, `CINEMA_R5_ACCEPTANCE.md`.
