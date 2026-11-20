# OSMANX WORLD — 1000 DOORS / R3 TECHNICAL ACCEPTANCE

Release: R3 / Authenticated Editorial Operations + Approved Public Map + Inbox + Digest + QA
Date: 2026-11-20
Base: stacked on R2 PR #80 (itself stacked on R1 PR #78). Do NOT merge to `main` out of order. Original production was not changed by local work.

## Delivery 1. Secure editorial CMS

Files: `moscow-1000/editor/index.html`, `editor/editor.css`, `editor/editor.js`, `services/moscow-1000-api/access.mjs`, `editorial.mjs`, `admin.mjs`, `migrations/0002_r3_editorial.sql`.

- Responsive Russian operator dashboard with editable method, verified aggregate metrics, evidence-backed day notes, location markers and documentary episodes.
- Validated Cloudflare Access RS256 JWT using JWKS, issuer, audience, expiration and explicit per-email roles. Missing or wrong signature fails closed.
- Supports optimistic draft revision check; publisher must explicitly approve. Optional two-person review enforced server-side.
- Every public release constructed from a field allowlist: evidence IDs, contact details and consent source references excluded. Public data is approved separately from internal CRM.
- Editorial audit with actor, timestamp, action and revision. Unpublish explicitly removes the live release.
- Documentary video approval requires manual confirmation of rights and real HTTP HEAD response of an allowlisted MP4/WebM path on the permitted same host.

## Delivery 2. Approved public discoveries + episode links

Files: `moscow-1000/public-r3.js`, `map.js`, `index.html`, `styles.css`, `episodes/01..10/index.html`.

- Public GET `/moscow-1000/api/public-release`; safe unpublished fallback if API is unavailable.
- Up to 60 editor-reviewed approximate city markers; internal exact coordinates rounded to 3 decimal places before public release; map labels and descriptions use DOM textContent.
- Dynamically updates episode cards, public evidence summaries and linked day route only after server release status published.
- Future documentary episode video starts only when the approved release includes real video metadata. Existing staged AI OSMANX STORIES remains visually and narratively separate.

## Delivery 3. Private lead moderation

Files: `admin.mjs`, D1 migration, editor UI.

- Authorized moderator inbox with filters, 25-item pagination, explicit private notes and statuses `new`, `triaged`, `replied`, `closed`.
- Individual PATCH status and irreversible DELETE of lead plus notes. Non-identifying operator audit event for erasure.
- No public API endpoint exposes raw lead rows, subscriber emails or D1 private tables.

## Delivery 4. Double opt-in digest operator

Files: `digest.mjs`, `admin.mjs`, `index.mjs`, migration.

- Per-episode email campaign draft → separate approval → queued delivery with explicit `DIGEST_DELIVERY_ENABLED` flag default false.
- Campaign can be created only for an already published documentary episode. Subscribers must have confirmed their email (R2 double opt-in).
- Persistent campaign and recipient-level delivery state in D1, bounded batches <=10 on a five-minute opt-in cron, DB claim before send, Resend stable Idempotency-Key.
- Each email contains an HMAC-signed unsubscribe link; GET has no side effect, POST validates signature and changes status. Existing R2 legacy unsubscribe tokens continue to work.
- Interrupted `processing` rows are intentionally not resent automatically; require review of Resend history. Resend idempotency retention is finite. Permanently failed sends are not represented as successful.

## Delivery 5. Verification / staging release gates

Files: `tests/moscow-1000-r3.test.mjs`, `tests/smoke_r3_browser.py`, `.github/workflows/moscow-1000-r3.yml`, `scripts/check_r3_staging.mjs`, `services/moscow-1000-api/README_R3.md`.

- Local Node tests use a temporary real SQLite database via `node:sqlite` and cryptographically signed RS256 test JWTs, with mocked JWKS and Resend external network responses.
- Local command: `node --test tests/moscow-1000-r1.test.mjs tests/moscow-1000-r2.test.mjs tests/moscow-1000-api.test.mjs tests/moscow-1000-r3.test.mjs` — **36/36 pass**.
- Chromium mobile 390x844 and desktop 1440x900 source-injection scripted smoke — **PASS**, no page JS exceptions; day switching, approved markers, null statistics, video metadata, and editor form interactions verified. These tests explicitly mock the backend and cannot prove live Cloudflare/D1/email/tile availability.
- `node --check` for all modified JavaScript entrypoints — **PASS**.
- GitHub Actions R3 workflow includes Node syntax tests, R1–R3 regression, and source safety checks. At time of local packaging: GitHub R3 CI is pending branch upload; update after PR is created.
- Read-only staging HTTPS route-check script prepared but **not run against a live staging origin**.

## Known blockers / release restrictions

1. No external Cloudflare Access application, D1 database, Turnstile site, verified Resend sender, `UNSUB_SIGNING_KEY` or safe deployment route was connected in this build. The API, editor and mailing will not function online until those are configured by an authorized owner.
2. Main `osmanx.world` does not yet contain R1/R2/R3 changes unless the stacked PRs are reviewed and merged. Production deployment was intentionally not attempted.
3. No real expedition documentary clips or approved business observations have been provided; **all documentary day videos remain planned** and public metrics stay unavailable.
4. Physical mobile browser tests, real Cloudflare Access request injection, live D1 backup/restore, actual SMTP/Resend mail and real map tile response have **not** been verified.
5. Public title/summary PII screening uses basic patterns plus explicit consent flags and approver review; there is no automated guarantee that all sensitive information is detected.
6. Editorial approval updates and campaign status are protected by D1 operations, but full high-volume concurrent send, rate limits and crash recovery need staging stress/reconciliation tests before production.

## Next five engineering priorities (R4)

1. Build staging deployment with real Cloudflare Access/D1 and access-policy acceptance (no production keys in GitHub).
2. Add an upload-to-review media pipeline (Cloudflare Stream/R2) with rights checklist and subtitle/chapters support.
3. Implement protected operator audit/backup/restore with versioned publication rollback and explicit privacy deletion workflow.
4. Complete 10-day episode production editor, SEO social cards and editorial release scheduler.
5. Run physical Android/iPhone + HTTPS E2E, monitoring, production reconciliation and limited pilot launch.
