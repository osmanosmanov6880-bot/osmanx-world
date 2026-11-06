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
