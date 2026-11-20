# OSMANX CINEMA R7 — operator-verified release, not production activation

## Delivered capabilities

1. **Race-safe lead claiming**: two managers competing to claim a new inquiry cannot both win. \`POST /cinema/leads/:id/claim\` locks the database row, requires its expected version, verifies state and authorizations, changes assignment and appends a versioned event. A manager may release their own lead; only an owner may release somebody else's lead. Legacy PATCH no longer lets managers overwrite another person's assignment.
2. **Privacy-limited duplicate investigation**: \`GET /cinema/leads/:id/similar\` compares the lead's exact normalized email to other leads inside the same tenant, using migration 016's index. It never sends email to the URL or returns the matched email, and **never automatically merges/deletes leads**. The 25-row preview reports its total and truncation.
3. **Sequence evidence and workload dashboard**: owner-only \`/leads/:id/audit-integrity\` compares the lead version against the number and range of recorded events. It explicitly does **not** claim cryptographic verification. \`/team/workload\` summarizes active, overdue and never-contacted assigned leads per active owner/manager. The manager UI offers claim, duplicate checks, an owner audit action, and a staff workload board with R6 fallback.
4. **Safer subject access**: R7 uses a CSRF-protected \`POST /cinema/privacy/search\` with email in JSON rather than a URL query, and \`Cache-Control: private, no-store\`. An older GET route remains temporarily supported for older already-deployed clients, marked deprecated, and should be removed only with a coordinated frontend/API release.
5. **Fail-closed staged canary and tests**: \`cinema-r7-readiness.mjs\` checks R6 prerequisites, migration 016, existing human approval flags, R7 review and that intake/telemetry are disabled. \`cinema-r7-canary.mjs\` accepts only a loopback HTTP staging URL, demands disabled collection, rejects private-route anonymous access and verifies that a completely empty public write gets 503. Independent PostgreSQL tests cover two concurrent managers, owner control, duplicate/foreign-tenant boundaries, synthetic history corruption, subject privacy and canary. Chromium checks mobile and desktop with R6 fallback.

## NO-GO conditions

The main GitHub deployment publishes **static assets only**. It does not apply migration 016, deploy an Industry OS API instance, update DNS reverse proxy, enable live intake, or configure any personal-data controller.

**Before enabling real customer collection:**
- Verify the legal entity responsible for processing, checked privacy notice, a monitored mailbox, documented legitimate basis/consent and the deletion/access policy with a person who has authority to approve.
- Confirm deployed API commit SHA and internally reproducible Docker image digest. Never install an unreviewed image from a mutable tag.
- Restore a recent encrypted database backup in an isolated instance; verify migration 016, same-tenant RLS and the exact active owner/manager memberships.
- Independently run test \`npm test\` on PostgreSQL 16 and the full mobile/desktop browser suite. Confirm two-manager claim conflict, legacy manager hijack 403, data subject access POST and the ability to reject untrusted tenants.
- Confirm CINEMA_PUBLIC_WRITE_ENABLED=false and CINEMA_AGGREGATE_EVENTS_ENABLED=false, and confirm the retention timer still works if intake is disabled.
- Record operator identity, approval timestamp, explicit evidence paths, tested image digest, and rollback path; do not treat environment strings alone as proof.
- Run \`npm run cinema:r7:readiness\` using least-privilege credentials in staging. Exit 2 indicates NO-GO.
- Run \`npm run cinema:r7:canary\` from a staging host that exposes API on \`http://127.0.0.1:3149\`, setting CINEMA_R7_STAGING_URL only to another *loopback* HTTP endpoint if needed. This test never uses a customer email, auth token or site cookies.
- When the independent live-data controller approves, perform a separate staged activation with a synthetic consented test lead, then validate removal of that test lead. Real public intake remains disabled until a distinct authorized release.

## Limits and evidence interpretation

- No automated calls, WhatsApp or outbound emails are performed.
- Email-matched leads are only *possible* duplicates; organizations may share a mailbox.
- Event version continuity is not a cryptographic audit or proof of an actual phone call.
- Staff workload quantities are not personal performance ratings.
- No live server activation is implied by successful static deployment or GitHub Actions.
- Staging localhost canary cannot confirm external TLS reverse proxy, web application firewall, DNS or the controller's real identity.

Related runbooks: CINEMA_R3_RUNBOOK.md, CINEMA_R4_RETENTION.md, CINEMA_R5_ACCEPTANCE.md, CINEMA_R6_ACCEPTANCE.md.
