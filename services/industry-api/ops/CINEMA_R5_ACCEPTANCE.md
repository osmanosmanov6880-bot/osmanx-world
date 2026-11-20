# OSMANX CINEMA R5 — acceptance and operator-controlled activation

## Five functional improvements
1. **Assignment:** lead owner account is validated against active owner/manager membership of the dedicated OSMANX operator tenant. Foreign or disabled staff cannot be assigned.
2. **Contact activity:** actual attempted contact, connected, no response or invalid contact are coded by an authenticated staff member. This DOES NOT send emails, WhatsApp messages, or make calls. Every event increments a versioned, tenant-limited history record; optionally clears a finished follow-up.
3. **Commercial performance:** private 7/30/90-day report counts database leads, recorded attempts and agreed deal stages by campaign, alongside separate anonymous film actions. Views are not unique users; 'won' is NOT confirmed payment.
4. **Subject rights:** owner-only exact-email search and individual JSON export, backed by tenant RLS; independent identity verification is explicitly required before export or deletion. Owner-only delete cascades to lead history. No public customer lookup.
5. **Release readiness:** migration 014, read-only RLS/staff checks and a mandatory operator approval gate, Node/PostgreSQL tests and mobile/desktop Chromium with R4 compatibility.

## Strict production rules

**Static GitHub deployment does not deploy containers, apply migration 014, provision operators, run deletion timers or enable public intake.** The public form must keep working via email fallback until backend and legal approval are separately completed. Do not represent completion of CI as a working live CRM.

Before handling real personal data:
- Verify the legal operator identity and contact mailbox actually monitored. Publish required operator details and a locally reviewed privacy notice.
- Obtain operator approval for recorded contact attempts, staff visibility, access exports and data deletion.
- Confirm dedicated operator tenant UUID and account membership, not a client tenant. Obtain consent before first collection.
- Back up and restore into isolated staging, run `npm run migrate` twice; verify schema migration 014 and database RLS.
- Verify both same-tenant assignment and foreign-tenant denials; confirm the owner/manager-only boundaries for contact actions.
- Configure and **verify** the existing daily retention timer and offsite backup; lead data remains limited to 90 days.
- For data access/deletion requests, perform human identity verification outside the browser. The checkbox is an acknowledgement, not technical identity verification.
- Record the independent evidence (approver, timestamp, source, execution outcome). Environment flags alone are not proof.

### Read-only operator evidence gate

Run from the intended server using least-privilege `industry_app` credentials:

```sh
cd services/industry-api
npm run cinema:r5:readiness
```

The gate expects CINEMA_TENANT_ID, CINEMA_RATE_SECRET, the existing R4 human attestation flags and CINEMA_R5_OPERATOR_REVIEWED=true **only after review**. A NO-GO (exit status 2) is expected before infrastructure and legal approvals. The gate cannot enable the public API.

### Safe sequence (operator action, NOT automatic from a website update)

1. Keep CINEMA_PUBLIC_WRITE_ENABLED=false and CINEMA_AGGREGATE_EVENTS_ENABLED=false.
2. Confirm staging URL is internal, transport is TLS and PostgreSQL is not exposed.
3. Apply migrations 012–014 using the separate migration role; repeat to check idempotency.
4. Run `npm test` with disposable PostgreSQL; verify mobile and desktop Chromium and full media checks.
5. Execute manual retention dry-run in a disposable copy with test leads; inspect backup recovery.
6. Run the R5 read-only gate; archive the results and independent approval evidence.
7. When approved, deploy the API image under the existing internal origin, then enable collection through a private config change and restart. Exercise a **synthetic consented request**, assign an operator, log a contact attempt and delete the synthetic lead.
8. Immediately on failure, disable CINEMA_PUBLIC_WRITE_ENABLED and restart the API. Validate that the public page shows email fallback.
9. Do not disable retention merely because intake was rolled back.

### Known limits

- No verified automatic outbound messaging, payments or commercial revenue integration.
- No evidence of unique visitor counts, ad causality or cleared revenue.
- Request export has a 1,000-event page cap and returns `truncated=true` if exceeded. Do not claim a truncated export is complete.
- Contact outcomes are manually reported and require human quality control.

Related: `CINEMA_R3_RUNBOOK.md`, `CINEMA_R4_RETENTION.md`.
