# OSGARD Director -- full program to world-class product release

**Dated 2026-10-27. Stage M184. Scope: engineering roadmap, not a claim of product completion.**

## Product thesis and strict boundary

Working hypothesis (not a user-approved six-product specification): a unified, permission-based workspace where a person specifies a real objective, a planning assistant outlines an evidence-backed plan, specialized authorized subsystems execute only approved tasks, and the result includes provenance, auditability and cost information. Six team labels are organizational placeholders until verified upstream ownership and exact interfaces are obtained. Real users and paid customers are not yet measured.

**Two separate completion lines:**

1. **Director Studio local product**: a functional local application for coordinating provenance, 180 provisional planning tasks, 28 provisional conflicts and nine unverified contracts. M184 provides a working vertical slice of this local control plane, not product ecosystem integration.
2. **World-class OSGARD product ecosystem**: verified six-product integrations, secure accounts and data, real task fulfillment, accessibility, international demand and reliable business economics. This line remains at product NO-GO.

## Phase A -- source identity and canonical baseline (12 planning tasks)

- Pin original M180 ZIP and M181 ZIP with the reported SHA-256 and verified original git ancestry. M181 reported SHA: `c6d0ff3ff9caa435e6928244ab70ecee8156747306ac3174faca82702be2969a`.
- Validate 180 original task IDs, 294 original dependency edges and their provenance; reconcile them against the separately created M182 plan (180 planning tasks, 174 planning edges). Do not equate the two boards.
- Confirm the owner, canonical repository, branch and commit of TITAN/KRAKEN, NEXUS/AETHERION, COMMERCE, HUMAN EXPERIENCE, GENESIS MEDIA and ORBITAL. A similarly named OSGARD GitHub repository is not automatically a canonical source.
- Pin asset origins and licenses, including the two disputed STYLO fonts. Exclude caches and SQLite files from source auto-merge.
- **Exit:** all six mappings owner-confirmed with durable source evidence; original 180/294 ledger independently reconstructed. `0/6` mappings currently.

## Phase B -- security and contract governance (48 planning tasks)

- Independently review 17 P0 and 11 P1 *actual* source conflicts, including SHA of both versions, exact diff, threat/behavior impact, reviewer distinct from author and failing negative cases; provisional slots are not conflict-resolution evidence.
- Reconstruct all nine original API contracts with producer, consumer, versioned schemas, error semantics, authorization scopes, idempotency and migration compatibility. Test both sides against the same pinned source.
- Threat-model authentication/SSO, IAM/RBAC, tenancy isolation, secrets, sandbox escape, untrusted AI tools, payment idempotency, data retention, PII exposure, supply chain and log tampering. Scope OWASP ASVS 5.0.0 as applicable; do not claim a certification.
- Require service-owned key custody, independent checks and segregated review, rather than self-issued approvals in the local studio.
- **Exit:** P0 blockers dispositioned, applicable security controls and all nine real contract suites pass on exact source; external review is recorded. Current progress: all blocked.

## Phase C -- real user-journey integration (90 planning tasks)

- Approve ONE narrowly defined job-to-be-done before building general-purpose features. Example candidate: create an auditable business deliverable from a validated user objective with no unauthorized external effects. This is an experiment, not approved product scope.
- Build one real workflow: user request -> NEXUS plan -> ORBITAL evidence -> explicit human approval -> TITAN sandbox -> GENESIS output -> HUMAN EXPERIENCE accessible review -> COMMERCE sandbox invoice/receipt (no live payment until compliance is cleared).
- Real data contracts and a portable identity for the entire workflow; no fake service stubs in final acceptance. Stubs may be used during local developer testing but must be labeled and excluded from an E2E release verdict.
- User-facing error, cancellation, retry, rollback where feasible, export, explanation of agent actions, permission prompts and RU/EN support. Use independent assistive-tech and physical mobile checks, not only a Chromium emulator.
- **Exit:** independently recruited users complete the chosen task through six real services on staging with full provenance. No such result exists now.

## Phase D -- production-like acceptance and independent release (30 planning tasks)

- Production-like SLI definitions and agreed SLO/error budget, p50/p95/p99 performance, concurrency, recovery, backups and non-synthetic RTO/RPO. No performance threshold can be retrofitted from this local demo.
- OpenTelemetry-style logs/metrics/traces, incident runbooks, failover drills, secrets rotation, vulnerability triage, data export/deletion and support/on-call ownership.
- Manual accessibility verification against applicable WCAG 2.2 AA checkpoints; user testing across browsers, physical phone devices and locales.
- Go-to-market: select segment and alternatives, interviews, documented pilot recruitment, repeated usage, paid demand and retention cohorts, price/cost ledger. Suggested experiment design: >=20 interviews, >=10 teams in an opt-in pilot and task success measurement -- **proposals, not achieved results**.
- Independently compare with at least three current alternatives on identical workflows, without claims of superiority absent data.
- Owner decision based on exactly pinned source, 180 original independent task receipts, all upstream gates and rollback rehearsals. No deployment automation may override STOP.

## Additional post-release blocks -- beyond a one-off launch

- **M190: Pilot release**: limited audited rollout, on-call, observable health, operational rollback, support requests and real product analytics.
- **M191: Internationalization**: RU/EN plus validated locale expansion, privacy/regional compliance, localization review, accessibility across assistive devices.
- **M192: Leadership evidence**: sustained engagement, customer outcomes, unit economics, security posture, independent benchmark and documented advantage to end users. No proclamation of "best in the world" without comparable external evidence.

## Exit decision matrix

| Gate | Current evidence | Exit proof required |
|---|---|---|
| Original M180/M181 provenance | M181 absent | Pinned original bytes and Git ancestry |
| Canonical teams | 0 of 6 | Six owner-signed SHA mappings |
| Original tasks | 0 of 180 accepted | Independent receipts for all original IDs |
| Actual source conflicts | 0 of 28 cleared | 28 exact-diff independent dispositions |
| Real contracts | 0 of 9 | Nine passing provider/consumer suites |
| Functional six-product E2E | 0 | Real staging user outcome, not stubs |
| User-grade security | No independent report | Scoped external security review and repairs |
| Accessibility | Chromium only for local studio | Keyboard/screen reader/physical mobile validation |
| Performance | Local studio diagnostic only | Product load/failure/recovery under representative load |
| Market | No verified customer data | Pilot adoption, retention, willingness-to-pay |
| Production | NO-GO | Separate accountable owner decision and recovery evidence |

## Critical path

`M181 original provenance -> six owner-confirmed upstreams -> conflict / contract review -> six-product staging workflow -> independent reliability/security/UX -> pilot customers -> release decision -> international operations`.

No calendar dates are promised: without source access, security owners and product scope, invented delivery dates are not meaningful. Run independent review at each gate; do not artificially complete remaining tasks by creating placeholder dashboards or test fixtures.
