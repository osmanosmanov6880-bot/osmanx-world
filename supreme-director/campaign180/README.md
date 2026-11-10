# OSGARD 180 - original campaign gate (Wave 0)

This code is the first direct implementation pass against the **original**
October 17, 2026 180-task master (not a synthetic M207 roadmap).

Implemented components:

1. Source registry with exact original SHA-256 and 6x30/60-90-30 checks;
   fail-closed upstream provenance; read-only Git file/hash/dependency inventory.
2. Per-task audit: 180 original IDs, related local evidence without fake acceptance,
   four SkillCred scope holds and four Noor missing-source holds.
3. CODEOWNERS plus review gate blocking protected master edits, unapproved six-team
   product sources, cross-team changes and tracked sensitive-file paths.
4. Versioned TaskEnvelope/ResultEnvelope validator with identity/tenant/scope/TTL
   controls, bounded safe JSON, result digest binding and SQLite replay guard.

**Not done:** independent upstream ownership approvals; real six-product merges;
lockfile/signature provenance; DevSwarm execution integration; independent
180-task review; production authorization. All original tasks remain 0/180
independently accepted until complete evidence is supplied.

Usage (from repo root with Python >=3.11):

    export PYTHONPATH="$PWD/supreme-director/campaign180"
    python3 -m campaign180 audit --root . --output ./out-180
    python3 -m campaign180 inventory --root . --output ./out-180/inventory.json
    python3 -m campaign180 gate --root . --change supreme-director/campaign180/README.md
    python3 -m unittest discover -s supreme-director/campaign180/tests -v

These operations are entirely local, never contact upstream repositories,
never execute user-supplied tasks, and do not perform payments/deployments.

## Current progress snapshot (2026-11-06)

- [Live 180-task audit snapshot](docs/CURRENT_AUDIT_180_RU.md) — **22 locally related / 150 no direct proof / 8 holds / 0 independently accepted** at code commit `7b68fcf9a40acdde1d24795f347e3a511afbef74`.
- [Machine-readable 180-task audit](data/CURRENT_AUDIT_180.json).
- New local code: deterministic signed source packaging (`repro.py`), hash-locked offline dependency preflight (`offline_deps.py`), transactional authorization gateway (`gateway.py`), and versioned workflow ledger (`workflow.py`).
- Scope caveat: not proof of upstream integration, externally authenticated execution, or release authorization.

## Wave 2 current register (2026-11-06)

- [Current 180-task status](docs/CURRENT_AUDIT_180_RU.md) and [machine record](data/CURRENT_AUDIT_180.json): 25 locally related, 147 without direct proof, eight holds, 0 independently accepted.
- [Resource scheduling and recovery](docs/WAVE2_CAPACITY_RECOVERY.md) (TITAN-X14/X15/X28).
- [Static patch and supply-chain security](docs/WAVE2_PATCH_SUPPLYCHAIN.md) (TITAN-X18/X26).
- The original five product upstream assumptions are **not** upgraded by this proof: 0/6 canonical team upstreams owner-approved.

## Wave 4 — functional local no-AI workflow (2026-11-06)

- [Live status of all original 180 tasks](docs/CURRENT_AUDIT_180_RU.md) / [machine registry](data/CURRENT_AUDIT_180.json): **30 locally related, 142 unproven, 8 holds, 0 independently accepted**.
- Working local site specification compiler, versioned project editor, typed tenant-scoped SQLite data models, import/export and offline static preview. [Repro and safety notes](docs/WAVE4_NOAI_SITE_BUILDER.md).
- Not yet integrated with original KRAKEN/NEXUS/Command upstream or authenticated HTTP; production remains NO-GO.

## Wave 5: functional local console and APIs (2026-11-06)

- [Russian instructions and limitations](docs/WAVE5_LOCAL_CONSOLE.md).
- [Live 180-task audit](docs/CURRENT_AUDIT_180_RU.md) / [machine registry](data/CURRENT_AUDIT_180.json): 32 locally related, 140 without direct proof, eight holds, 0 independently accepted.
- Local application roles, idempotent record workflows and browser UI with a loopback-only WSGI API. No production or external server connection. Canonical upstream integration still blocked.

## Wave 6 — interactive editing and browser acceptance (2026-11-06)

- [Original 180 task status](docs/CURRENT_AUDIT_180_RU.md) / [machine ledger](data/CURRENT_AUDIT_180.json): **33 locally related / 139 no direct proof / 8 holds / 0 independently accepted**.
- Real `record.created/record.updated` transaction-bound rules, no-code section rearrangement, bounded corrupted workflow quarantine, negative tests and [Chromium desktop/mobile E2E](docs/WAVE6_CHROMIUM_ACCEPTANCE.md).
- [Bounded repair rationale](docs/WAVE6_BOUNDED_REPAIR.md). Browser CI and independent upstream review remain distinct requirements; no production release.

## Wave 7 — visual typed schema migrations and forms (2026-11-06)

- [Schema editor implementation and safety](docs/WAVE7_VISUAL_SCHEMA.md)
- [Machine readable original 180 ledger](data/CURRENT_AUDIT_180.json) and [full status table](docs/CURRENT_AUDIT_180_RU.md): 33 locally related, 139 without proof, 8 holds, 0 independently accepted.
- API-backed model editor, add-field migrations, disabled static form preview, browser acceptance. No production deployment or original upstream acceptance.

## Wave 8 — no-AI form field editor, tenant-safe relations and bounded schema rename

- [Wave 8 design, migration and rollback notes](docs/WAVE8_FORMS_RELATIONS_MIGRATIONS_RU.md)
- [Current 180-task ledger](docs/CURRENT_AUDIT_180_RU.md) and [machine registry](data/CURRENT_AUDIT_180.json): **33 local-code links / 139 no evidence / 8 holds / 0 independently accepted**.
- Preview forms cannot submit, API is loopback-only, and field renames are bounded to 500 records with immutable local receipts. No production deployment.

## Wave 9 — relation migration and inspected page rollback (2026-11-06)

- [Implementation, safety/rollback and negative tests](docs/WAVE9_RELATIONS_RESTORE_RU.md).
- [Updated 180 original ID ledger](docs/CURRENT_AUDIT_180_RU.md) and [machine registry](data/CURRENT_AUDIT_180.json): 33 local-code links, 139 without direct evidence, eight holds, **0 independently accepted**.
- Atomic relation field rename with verified link index, blocked live retarget, inspect-first compatible page restore to a new revision, Russian UI. No production deployment or upstream acceptance.

## Wave 10 — explicit live relationship remapping and isolated recovery (2026-11-06)

- [Implementation and safety documentation](docs/WAVE10_MAPPED_RELATIONS_RECOVERY_RU.md)
- [Original 180-task audit](docs/CURRENT_AUDIT_180_RU.md) / [machine ledger](data/CURRENT_AUDIT_180.json): 33 local-code links, 139 without direct evidence, 8 holds, 0 accepted.
- Inspect-and-confirm mapped live relations; project-only offline recovery bundle and create-only restore. Chromium QA extends to manual mapping and recovery diagnostics. Main and production unchanged.

## Wave 11 — CI queue hygiene and real isolated SQLite recovery drill (2026-11-06)

- [Wave 11 report and limitation disclosure](docs/WAVE11_ISOLATED_RESTORE_AND_CI_RU.md).
- [180 original IDs](docs/CURRENT_AUDIT_180_RU.md) / [machine ledger](data/CURRENT_AUDIT_180.json): 33 locally related, 139 without direct proof, 8 holds, independently accepted 0.
- Python CI now verifies a full synthetic recovery into a scratch project; Chromium clicks the owner-only restore drill. PR checks are deduplicated and superseded runs canceled. No deployed services or source database modifications.

### CI backlog maintenance (Wave 11)

All 17 pre-existing M187/M191-M206 workflow checks retain their test steps and event path filters, but now use per-workflow PR/push concurrency cancellation. The two Original-180 campaign checks use PR-only triggers and manual dispatch. This removes stale queued checks, not an unavailable GitHub runner; independently accepted remains 0/180.

## Wave 12 — archive-safe typed migrations and 12-table restore assertions

- [Wave 12 regression and recovery findings](docs/WAVE12_ARCHIVED_SCHEMA_RECOVERY_RU.md).
- Repair archived tombstones during required-field migrations (flag-preserving, bounded, transactional).
- Restore drill now hashes and compares 12 project table families and closes SQLite backup descriptors.
- CI requires both synthetic `demo` and `archived` restore runs; no PASS claimed until a job completes.
- [Original 180 ledger](docs/CURRENT_AUDIT_180_RU.md): 33 related, 139 without evidence, eight holds, independently accepted 0.

## Wave 13 — real CI diagnostics and 320/390px mobile fixes

- [Wave 13 source, browser, security-gate results](docs/WAVE13_REAL_CI_MOBILE_SECURITY_RU.md).
- 360/360 local Python tests passed on 3.11 and 3.13; aggregate Python workflow remains FAIL on the intentional protected-source gate.
- [Chromium acceptance SUCCESS](https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/42174047330): 21 flows, 13 screenshots, zero JS exceptions, 390/320px mobile checks.
- Corrupt recovery exports fail closed with stable API domain errors; workflow test now defines a valid dependency instead of an invalid relation-write.
- [Original 180 audit](docs/CURRENT_AUDIT_180_RU.md): **33 locally related, 139 with no direct proof, 8 holds, 0 independently accepted**. No merge or production deployment.

## Wave 13 — fixed-operation worker, POSIX budgets, local quota leases, chaos and dedicated CI (2026-11-08)

- [Wave 13 technical report and limits](docs/WAVE13_LOCAL_EXECUTOR_RESOURCE_CHAOS_RU.md).
- [Current 180 original task ledger](docs/CURRENT_AUDIT_180_RU.md) / [machine registry](data/CURRENT_AUDIT_180.json): **36 local-code links, 136 unproven, 8 holds, 0 accepted**.
- No arbitrary-code execution, container isolation, network namespace or production deployment. Linux local test verification is distinct from the still-blocked original protected-source release gate.

## Wave 14 — signed local execution, durable ledger, HMAC checkpoint, rootless OCI verification (2026-11-09)

- [Wave 14 technical report](docs/WAVE14_SIGNED_EXECUTION_OCI_RU.md) and [original 180-task ledger](docs/CURRENT_AUDIT_180_RU.md).
- Local CI [passed for Python 3.11 and 3.13](https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/42554635337).
- 36 related local IDs, 136 without direct proof, 8 holds; 0 independently accepted. Rootless OCI policy is not physically attested on a production Linux host. Protected-source release gate remains NO-GO.

## Wave 15 — chained compute journal, HMAC v2, sealed Linux memfd and offline OCI host probe (2026-11-09)

- [Wave15 technical report](docs/WAVE15_JOURNAL_SEALED_WORKER_OCI_RU.md), [original 180 task audit](docs/CURRENT_AUDIT_180_RU.md) and [default-off OCI instructions](oci-probe/README_RU.md).
- 17 new Python tests plus multiprocess SQLite contention, synthetic end-to-end acceptance and separate dual-Python CI. Physical OCI host validation is NOT yet confirmed.
- 36 locally related IDs, 136 unproven, 8 holds; 0/180 independent acceptance, source release NO-GO.

## TITAN-X16–X20 — original five-task implementation (2026-11-10)

- [Exact five-task evidence](docs/TITAN_X16_X20_EXECUTION_RU.md) and [machine-readable blocked upstream status](data/TITAN_X16_X20_PROGRESS.json).
- Implemented review-gated stage manifests, SHA256-pinned deterministic static code ZIP, signed local patch inspection, bounded repair/replacement, and mobile no-AI page management in existing runtime.
- Python 3.11/3.13 first-five tests passed in [dedicated CI](https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/42836551304). Browser acceptance has a separate [Chromium run](https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/42837105529).
- Canonical upstream KRAKEN/DevSwarm/Command approval and independent acceptance are missing. Source release remains NO-GO; nothing deployed.
