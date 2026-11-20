# M193 release status

Date: 2026-11-05

Scope: new, offline CRM runtime and local Russian Studio on top of M192.

Acceptance criteria for this stage:
1. Source code, tests and Russian locale published in GitHub PR #7.
2. CI validates source hashes, M193 tests, M192 regression suite and JS syntax.
3. Full local CRM walkthrough: create customer and deal, move stage, schedule
   and complete contact; reopen persisted SQLite and verify data.
4. No change to default branch or production; original task gate stays 0/180.

Remaining gaps: true upstream integration for six domain products, external
independent product acceptance, deployment hardening, public account management,
backups for the new CRM tables, data retention and privacy review. These are
explicitly outside the locally verified M193 subset.
