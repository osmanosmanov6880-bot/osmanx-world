# TITAN-X27/X29 — synthetic observability and fault drills

- audittrail.py records only a fixed event category, canonical trace and task
  IDs, tenant, timestamp and bounded numeric metadata, with an SQLite hash
  chain. It refuses UPDATE/DELETE via triggers and detects hash mismatches,
  including against a separately supplied checkpoint digest. A database admin
  can bypass triggers and rewrite the chain; external witness/signatures remain
  absent. This is local evidential logging, not an independent trusted audit.
- resilience.py constructs a real SQLite queue/scheduler and runs synthetic
  crash-injection, timeout and lease recovery, bounded retries, digest-tamper
  refusal, multithreaded reservation and restore-to-new-file drills. No
  production traffic, host chaos, or security isolation is tested. Performance
  measurements are local wall time only, not SLO evidence.
- Unit and integration tests for both modules are standard-library-only.
  CI includes a bounded synthetic drill and retains a JSON report.

No actual OCI worker is automatically started; no original task is independently
accepted. Production and main remain untouched. Rollback is revert of the
isolated changes to campaign180 and workflow only.
