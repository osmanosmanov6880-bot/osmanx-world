# OSMANX Guest Intelligence R7 — protected staging and recoverable evidence

Date: 2026-11-18. No production VPS changes in this cycle.

## Five fully implemented blocks

1. **Verified PostgreSQL readiness.** Migration 006 grants industry_app SELECT-only access to schema_migrations. The new src/readiness.mjs checks three required Guest migrations, four protected tables, FORCE RLS, effective SELECT privileges, and absence of SUPERUSER/BYPASSRLS/ledger update grants. /health/ready returns 503 when verification fails; /health/live remains a pure liveness endpoint. Errors do not disclose credentials or SQL.

2. **Restorable evidence, not just tables.** scripts/dr-guest-proof.mjs builds a synthetic archived pilot with two separate staff accounts, two aggregation periods, an independent review, immutable proof digest, audit events and an outbox entry. The disaster-recovery CI encrypts with two separate age recipients, restores in two industry_dr_* databases, independently recomputes SHA-256 from PostgreSQL JSONB and checks both hashes against the original pre-backup digest. Live databases are rejected by the script.

3. **Isolated operator staging.** ops/compose.staging.yml creates an isolated Docker project, network and DB volume. API binds only to 127.0.0.1:3149, no external worker, and GUEST_WRITES_ENABLED=false. ops/stage-launch.sh supports plan, apply and stop. The default plan makes no changes. Apply requires a private environment file outside the Git checkout, a valid local default Docker context, an empty staging project and an explicit R7_STAGE_ACK. On errors, the API stops and data is not deleted; stop also preserves the DB.

4. **Real production-mode HTTP acceptance.** test/guest-r7-prod-http.test.mjs runs the live Fastify socket in production configuration against synthetic PostgreSQL. Checks Secure, HttpOnly and Strict cookies, tenant isolation, Origin/CSRF, 503 write gate, 401 after enabling writes without login, one-time second-staff onboarding, idempotent intake, pilot approval by a different employee, verified evidence hash and archive.

5. **Release verification plus full CI staging.** Reproducible build contains an explicit RELEASE.json contract with the source commit, latest migration and false write flag, along with staging deployment files. The verifier rejects checksum mismatch, duplicate tar paths, links and special files, overlarge archives, wrong revision and missing bundle members. DR CI now executes the whole operator plan, rejects apply without acknowledgment, then runs dedicated staging database/provisioning/migrations/bootstrap/API/health and stops the API without deleting volumes. R6 release CI still verifies reproducible archives and a nonroot Docker image.

## Important operating boundary

The prior read-only VPS audit confirmed that the existing deploy-osmanx account cannot install Docker/Node, change Nginx, sudo or administer /opt. The current VPS and osmanx.world therefore remain unchanged in R7. No backend, live user accounts, Stripe, VAT, subscriptions or client payments were enabled on that VPS.

For an independently authorized operator on a dedicated staging machine:

    bash ops/verify-release.sh osmanx-industry-REVISION.tar.gz
    node scripts/preflight.mjs /absolute/private/staging.env
    bash ops/stage-launch.sh plan /absolute/private/staging.env
    R7_STAGE_ACK=CONFIRM_ISOLATED_STAGE_ONLY bash ops/stage-launch.sh apply /absolute/private/staging.env

To stop only the staging API while retaining the DB:

    R7_STAGE_ACK=CONFIRM_ISOLATED_STAGE_ONLY bash ops/stage-launch.sh stop /absolute/private/staging.env

The examples above are documented commands, not production actions already executed. Only an authorized independent administrator may approve a live reverse proxy, environment secrets, DNS, monitoring, backups, legal data basis and business onboarding.

Never run docker compose down -v on live data. A failed run must be investigated without deleting the database or evidence log. A 200 /health/ready indicates schema and privilege correctness, not evidence of a signed customer contract or actual revenue.
