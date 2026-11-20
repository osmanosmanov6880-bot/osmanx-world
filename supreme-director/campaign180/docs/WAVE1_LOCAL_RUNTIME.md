# TITAN Wave 1 local runtime — 2026-11-06

Original tasks: **TITAN-X07, X08, X11, X12, X13** from `DIRECTOR_MASTER_180.md`.
This is a **local, nonproduction integration harness**, not completion of the
canonical KRAKEN / DevSwarm / Command upstream tasks.

## Implemented code

- `campaign180/access.py` — an explicit membership/role table scoped by tenant,
  least-privilege role capability allowlists, per-resource expiring grants, durable
  revocation and audit metadata. An external *verified identity adapter* must
  supply `authenticated_tenant` and `authenticated_actor`. The envelope is
  **never** considered a verified identity credential.
- `campaign180/queue.py` — SQLite durable inbox with one transaction per
  transition; idempotent enqueue scoped by (tenant, key); bounded retries;
  atomic worker reservation; monotonically increasing lease fencing;
  crash recovery; dead-letter on expiry or exhaustion; no payload in diagnostics.
- `tests/test_access_queue.py` — positive, negative, cross-tenant,
  concurrency, stale-worker, timeout and restart scenarios.

## Security/limits

- No public identity provider/JWT integration, no browser permissions, no real
  worker dispatch, no external side effects, no multi-server Postgres scheduler.
- A matching persisted result digest is **not** exactly-once execution:
  downstream effects require their own idempotency/fencing and independent tests.
- Local SQLite file needs filesystem access controls, backups and encryption
  appropriate for actual data before any production use. Do not put credentials
  in task bodies. The current contract rejects common secret field names.
- Provision and grant functions are intended only for privileged local setup.
  They must not be mounted directly as unauthenticated endpoints.
- Existing production / main / payments are untouched.

## Reproduce

From repository root, Python 3.11+ (stdlib only):

```bash
PYTHONPATH=supreme-director/campaign180 python -m unittest discover \
  -s supreme-director/campaign180/tests -p 'test_*.py' -v
PYTHONPATH=supreme-director/campaign180 python -m campaign180 audit --root . --output /tmp/og-audit
```

**Review gate:** 0/180 independently accepted until six real canonical upstream
URL/SHA records, verified owner approval, external authentication adapter,
upstream integration, destructive/restore E2E and independent reviewer evidence.
Do not mark any task VERIFIED or authorize a release based on this harness.

**Rollback:** revert the single Wave 1 commit, delete only the *new local*
`access.db` and `jobs.db` files used in an isolated test environment after
export/retention review. Never delete any pre-existing project database.
