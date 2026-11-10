# Wave 2 / local capacity and recoverable SQLite state

Related original IDs: TITAN-X14, TITAN-X15 and TITAN-X28.

- `scheduler.py`: cross-**process** (same-host, same-DB) SQLite arbitration;
  fair round-robin across tenants; fail-closed per-tenant resource budgets;
  costs configured by trusted capability, not user task bodies; atomic
  capacity reservations with lease fencing, expiry/recovery, bounded retries,
  and stale-worker rejection. CPU/RAM/disk limits are *admission estimates*,
  not sandbox enforcement. There is no distributed multi-server consensus
  or actual worker dispatch. Do not claim original TITAN-X14 completion.
- `backup.py`: SQLite online consistent backup API, integrity and FK checks,
  hashed canonical manifest, exclusive new-file restore (never overwrite),
  and short-lived restore drill. No encryption, signing, offsite persistence,
  retention schedule, product backup contract, or verified recovery RTO/RPO.
  This does NOT establish a canonical TITAN-X28 product recovery procedure.

Scope is a local isolated harness only. Runtime grants must be supplied by
a separate authenticated IdP adapter. Never open these privileged provisioning
or backup functions directly on an unauthenticated network interface.

Tests cover cross-tenant capacity, multiprocess reservation, round-robin,
revocation, retry release, lease fencing, corrupted snapshots, tampered
manifests, symlinks, and restoration into a new database.

All independently accepted original tasks remain 0/180.
