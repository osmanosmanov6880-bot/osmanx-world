# OSMANX Guest Intelligence R18 — external custodian and disaster-recovery verification

19 November 2026. Stacked draft above R17 PR #51, R16 #49, R15 #48 and R14 #47. This code does NOT merge PRs, deploy to the live VPS, enable real customer collection or modify public osmanx.world.

## Five engineering blocks

1. Independent Ed25519 custodian receipt. An external custodian (a third trusted person/key, distinct from R17 owner and manager) signs the full release SHA, registry revision/digest, R17 journal head/sequence/checkpoint digest and 4-hour maximum lifetime. A missing or partial GUEST_R18_* configuration fails closed, never falling back to R17-only.
2. Durable PostgreSQL migration 013: guest_external_anchor_fence stores a monotonic external receipt high-water mark, FORCE RLS, no runtime DELETE/INSERT privilege, immutable history in guest_external_anchor_receipts, and a trigger rejecting rollback. R18 verification runs inside the SAME SQL transaction as the R17 check and protected Guest mutation, and is checked again before COMMIT.
3. Portable non-PII signed evidence: scripts/r18-proof.mjs exports R16 registry, R17 journal and owner/manager witness records, plus R18 custodian anchor into an integrity-checked JSON package with per-file SHA-256 and overall digest. Keys and guest records are excluded. Verification independently checks all signatures.
4. Read-only DR: scripts/r18-dr-rehearsal.mjs connects exclusively to an ALREADY RESTORED industry_dr_* database. It uses BEGIN READ ONLY, compares migration 013, R17 checkpoint, R18 anchor and append-only receipt with the independently verified evidence. It never restores, drops, inserts, lifts a STOP, or declares customer GO.
5. Release-chain & chaos acceptance: scripts/r18-release-gate.mjs checks pinned GitHub PR #47/#48/#49/#51 dependencies and exact CI commits read-only. Legal basis, client contract, verified encrypted backup recovery, offsite retention, two human approvals and an operator change window remain required. Automated tests use only synthetic tenants, local PostgreSQL and temporary Ed25519 keys.

## Private operator environment (illustrative only)

    GUEST_R18_ANCHOR_FILE=/secure/external-receipts/anchor.json
    GUEST_R18_CUSTODIAN_PUBLIC_KEY=/secure/pinned-trust/custodian.pub.pem
    GUEST_R18_MIN_REVISION=1
    GUEST_R18_MIN_SEQUENCE=3

These settings ADD to the complete R14-R17 environment. The anchor JSON and pinned public key must be in different private directories, separate from R16/R17 evidence and source checkout. All private JSON files require mode 600 and must not be symlink paths. The private custodian key remains on the custodian's independent device, never on the API machine, GitHub or in chat.

The API verifies a local copy of the signed receipt. That copy alone is NOT proof of offsite or WORM storage. A separately administered immutable object store, retention lock, receipt of external upload and periodic restore audit must be installed and verified by operators.

## Third-party custodian signing flow

On the custodian's trusted offline machine, with full separately verified R16/R17 evidence:

    cd services/industry-api
    node scripts/r18-anchor-signer.mjs plan /private/anchor-plan.json
    node scripts/r18-anchor-signer.mjs sign /private/anchor-plan.json /private/custodian-private.pem /private/anchor.json

The signing station creates new files only, with private permissions. It never overwrites, publishes or activates a tenant. An operator later atomically distributes the signed receipt and maintains independent external minimum-sequence pins.

## Portable evidence and recovery

    node scripts/r18-proof.mjs export /private/evidence-r18.json
    node scripts/r18-proof.mjs verify /private/evidence-r18.json

The proof contains metadata and signed event history, never private Ed25519 keys or guest identities. Transfer only through approved secure channels to separately administered encrypted WORM/retention-locked storage. The report intentionally says offsiteStorageVerified=false because this app does not upload or attest any external storage.

On a separately restored and isolated PostgreSQL database, after using the existing two-recipient encrypted ops/restore-dr.sh workflow:

    DR_RESTORE_DB_URL=postgresql://.../industry_dr_audit node scripts/r18-dr-rehearsal.mjs /private/evidence-r18.json

It returns technicalRestoreReady only if the DR copy exactly matches the signed checkpoint, PostgreSQL fence and receipt. A stale, missing, future or modified history remains NO-GO. Output always says legalGo=false, customerGo=false and productionChanged=false. The isolated CI DR job uses synthetic data and two independently generated AGE keys.

## Release-chain readiness

    node scripts/r18-release-gate.mjs --github

Read-only report: verifies head SHA, base branch, merged state and success of required CI jobs on R14 #47, R15 #48, R16 #49, R17 #51. No partial answer is treated as merged. Manual offsite retention, legal/privacy approval, proven backup recovery, client contract and independent operator acceptance are all assumed missing until independently documented. The gate never merges, deploys or changes a write flag.

## Security limits

* R18 SQL history is append-only to a low-privilege API role, not immutable to a database superuser. Recovery assurance depends on truly independent trust anchors and retained offsite evidence.
* A PostgreSQL restore to a prior checkpoint cannot be deemed ready merely because the API is healthy. It must match the external signed evidence and a recovery protocol.
* No command automatically removes R13 safety holds or R16 emergency STOP markers.
* No green CI result or technicalReleaseReady status substitutes for legal authorization or human approval.
* All commits in this PR are source and CI only; production remains unchanged.
