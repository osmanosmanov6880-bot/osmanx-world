# OSMANX Guest Intelligence R15 — tenant-bound signed admission

19 November 2026. Stacked on R14 PR #47. No production deployments or customer-data collection.

## Five delivered engineering blocks

1. **Cryptographic tenant permit.** Strict schema osmanx.guest.r15.tenant-permit.v1. The complete release commit, tenant UUID, R14 evidence digest, issuance and expiry (at most 24h), independent owner and manager Ed25519 signatures are authenticated. Altering a tenant, commit, signer, digest or expiry invalidates the permit.
2. **Server-side production enforcement.** GUEST_WRITES_ENABLED=true alone does not permit a Guest mutation. Production POST, PATCH, PUT and DELETE require existing FORCE RLS/migration readiness and a fresh R14/R15 signed bundle. Following authentication, the current session tenant UUID must match the signed tenant. Existing CSRF, R12 launch gate and R13 hold enforcement remain in force.
3. **Synthetic security fixtures and regression coverage.** Ephemeral signing keys and external private files generate two independent signatures. The tests cover expired attestations, unauthorized tenant, tampering, wrong signer, mismatched release, missing file, private file permissions and the legacy R7/R10 HTTP flows.
4. **Independent operator review.** The R15 read-only review combines the permit with five GET-only loopback canary checks. It never follows redirects, submits cookies, changes a write flag or clears a safety hold. This is a technical review, not a customer launch.
5. **CI and rollout instructions.** Node 22 offline tests, production mutation guard regression, and unchanged isolated canary. Main, DNS, VPS and existing PostgreSQL datasets are untouched.

## Permit contract

The permit object contains exactly these properties: schema, tenantId (UUID), releaseCommit (full 40-hex Git SHA), admissionDigest (SHA-256), issuedAt, expiresAt, attestations.

Attestations contain exactly one owner and one manager, each holding role, actorId and a base64 Ed25519 signature of permitMessage(permit, approval). The public keys must be independent and administrator-pinned, never obtained from the untrusted permit itself.

The source R14 admission evidence must contain 11 verified entries and independent owner/manager signatures (within their respective validity periods). R15 intentionally re-verifies R14, rather than trusting an unsigned operatorGo flag.

## Required production environment after independent human authorization

- GUEST_WRITES_ENABLED=true only on the customer-authorized production API, not the R14 canary
- GUEST_RELEASE_COMMIT: immutable full Git SHA for the deployed production artifact
- GUEST_R15_ADMISSION_FILE: absolute path to private signed R14 JSON, permissions 600
- GUEST_R15_PERMIT_FILE: absolute path to private signed R15 JSON, permissions 600
- GUEST_R15_OWNER_PUBLIC_KEY: absolute path to administrator-pinned owner Ed25519 PEM
- GUEST_R15_MANAGER_PUBLIC_KEY: absolute path to administrator-pinned manager Ed25519 PEM

All paths must be regular, non-symlink files outside the application checkout. No private Ed25519 key, database password, PII or real customer data may enter GitHub.

Offline technical check on the separately authorized local canary:

    cd services/industry-api
    node scripts/r15-review.mjs --tenant TENANT_UUID

The report must NOT be treated as legal authorization or VPS deployment. It requires a successful external DR restore, human legal/privacy review, the actual customer protocol and independent operator confirmation. For every production Guest mutation the short-lived external permit is re-read; expiration, revocation by deleting the file, or tampering all close the write gate.

The R14 loopback canary remains fixed at GUEST_WRITES_ENABLED=false. A single permit authorizes precisely one tenant; multi-tenant rollout requires an independently designed signed authorization registry, not broadening this file. Never run docker compose down -v.

## GO / NO-GO

R15 CI establishes offline cryptographic and API behavior only. It does not provision production Nginx, Docker, VPS admin credentials or real customer consent. If no independent VPS and legal acceptance exists, remain NO-GO. Do not collect personal data, activate payments, or advertise a live production API based only on a green PR.
