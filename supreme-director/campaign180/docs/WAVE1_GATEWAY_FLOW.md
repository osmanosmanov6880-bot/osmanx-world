# Original 180 — atomic local gateway and staged engineering flow

Local implementations related to TITAN-X07, X08, X11, X12, X13, X16.
**Not full upstream integration, not independent acceptance.**

## Security repair: single database transaction

The earlier `DurableLocalQueue.enqueue` relied on a mutable dictionary
annotated `LOCAL_DIRECTORY_POLICY_ONLY`. That metadata was not an
authentication credential and could be forged. New
`TransactionalLocalGateway` performs membership, scoped grants, capability,
tenant binding, expiry, and `TaskEnvelope` checks in **one SQLite BEGIN
IMMEDIATE transaction** that writes the queue entry. It also records a member
revision and requires it at reservation and finalization time. Revocation,
role changes or grant expiry make prior jobs ineligible and dead-letter jobs
instead of leasing them to local workers.

Both stores must use the *same* SQLite DB path. No network or external
dispatch occurs. Old low-level queue APIs remain for internal compatibility,
but MUST NOT be exposed as an authenticated product endpoint. A server-side,
cryptographically verified IdP adapter is still absent, so this is a guarded
**local harness only**. Never trust claimed user IDs from an untrusted caller.

## Workflow state engine

`LocalProjectFlow` persists content SHA-256 digests and an event hash chain.
It allows `brief -> spec -> code -> reviewed -> release_candidate`, plus
rejected review / revision. It requires versioned compare-and-swap transitions,
rejects a project owner reviewing their own code, and binds review evidence
to the exact latest code digest. `release_candidate` is a *local marker*,
not a verified approval or deployment authorization.

Use `python -m unittest discover -s supreme-director/campaign180/tests -v`
with `PYTHONPATH=supreme-director/campaign180`.

No original 180 package is independently signed off yet. Missing six
canonical upstream repo/SHA pairs, owner-approved authentication integration,
real worker adapters, staging failure drills, separate reviewer evidence.
**0/180 accepted; no automatic release**.

Rollback: revert this additive branch commit. New local test databases can be
discarded only after confirming they are isolated scratch data; never delete
existing production/project databases.
