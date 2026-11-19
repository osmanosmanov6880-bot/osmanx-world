# OSMANX Guest Intelligence R33 — independent staging, rollback and privacy evidence

19 November 2026. Built on R32 PR #67 pinned at `1c1c7047cd1d197fea0289857b2bacee141baaea`. Stacked Draft; no changes to `main`, live site or production guest collection.

## Five major blocks

### 1. Exact 19-PR source review

`src/guest-r33-source.mjs` and `scripts/r33-review-github.mjs --github` validate the previous 18-PR graph plus the R32 PR #67 head SHA, branch/base, exact parent commit, five named successful source CI jobs and source vs. latest known main Git tree. These use **GitHub GET only**. An already green source branch is **not** green final `main`. Human code review and manual sequential merges still required. No merge, workflow dispatch, push or deployment capability.

### 2. Signed staging host metadata

`src/guest-r33-signatures.mjs` and `src/guest-r33-staging-witness.mjs` bind the exact R32 release SHA, tree, tenant/pilot, fixed dedicated `https://staging.osmanx.world` origin, two separated privacy-safe GET snapshots (20 observations total), claimed TLS certificate SHA-256 and claimed DNS answer SHA-256 to independently pre-pinned Ed25519 public keys of `staging_operator` and `security_reviewer`. Signatures are domain-separated, nonce-bound and expire within 10 minutes. Repeated signatures/keys, stale proofs, wrong pilot, host drift, 200 response from private routes, or mutation of digest all fail closed.

**Important limitation:** DNS/TLS values and HTTP snapshots are claims in signed metadata. This module performs no DNS query, TLS handshake or live HTTP request. A signature does not prove that the named individual controlled the real VPS. The existing explicitly approved R31 CLI can inspect staging, but it is not launched by R33 API/CI.

### 3. Separate simulated rollback with tamper-evident event chain

`src/guest-r33-rollback-ledger.mjs` records exactly five states: `checkpoint → isolate → restore → verify → abort`. Roles are constrained (release manager, recovery lead and independent auditor), distinct actors, monotonic times, a separate `industry_dr_r33_*` disposable target and SHA-256 linking every event. Invalid order, actor reuse, a production target, broken digest, foreign tenant, expired record or a missing step is rejected. The final state is `abort`; no STOP lift, database connection or physical restore exists in this module.

### 4. Four-signature, privacy-minimized client review

`src/guest-r33-privacy.mjs` requires two additional signed roles (`client_representative`, `privacy_reviewer`) and hashes of the intended client agreement, privacy notice, processing agreement, lawful-basis assessment and deletion plan. The only allowed stated pilot purpose is `guest_experience_aggregate`, retention is limited to 1–30 days, and the policy prohibits personal identifiers and third-party export. Four distinct independent public keys must be verified across staging/privacy. The validator checks signatures and scope, **not the actual contracts, legal validity, true identity or operational compliance**.

### 5. Unified audit, RU cockpit, Fastify, CI and reproducible artifact

`src/guest-r33-proof-bundle.mjs` checks a single offline evidence package and binds source tree, two stage snapshots, disposable rollback, privacy signatures and one tenant/pilot. Returns `humanReviewQueueEligible:true` only for valid signed metadata. **Always returns `productionAuthorized:false` and `customerGo:false`.** Four trusted public keys must be pinned separately, not supplied as part of incoming evidence.

CLI for an authorized offline operator (replace file locations and use independently pinned PUBLIC keys):

```bash
cd services/industry-api
R33_TRUSTED_PUBLIC_KEYS_FILE=/absolute/operator/trusted-public-keys.json \
  node scripts/r33-offline-review.mjs --offline < /absolute/operator/redacted-r33-evidence.json
```

CLI reads up to 256 KiB from stdin, requires a regular trust file not writable by group/others, does not make network requests or print the input evidence, and exits 2 on invalid metadata. Successful exit only means `humanReviewQueueEligible`.

Read-only application endpoints, tenant-scoped to owner/manager roles:

- `GET /api/industry/v1/guest/pilots/:id/r33/readiness`
- `GET /api/industry/v1/guest/pilots/:id/r33/report.csv`

Both use `Cache-Control: no-store`, bounded 10-minute SHA-256 report and spreadsheet formula-safe CSV. The new Russian R33 UI shows unmet review conditions and exposes neither an upload nor a deployment action. Regression suite adds tampering/replay/scope/expiry/role isolation tests, real PostgreSQL/Fastify tenant security, and five read-only CI jobs. Manifest adds `independentReviewBundleSupportedR33:true` while preserving `guestWritesDefault:false`.

## External release blockers — NO-GO

The R33 GitHub CI can confirm implemented code, **not** that real staging, offsite DR custody, physical rollback, lawful client processing, final merged main CI or 19 human code reviews have actually happened. The project remains Draft, with zero production deployment, customer data access, live guest writes, migration, PR merge or STOP lift. Independent authorized operators must complete and witness those real-world checks before any publication decision.
