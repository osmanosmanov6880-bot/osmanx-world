# OSGARD SUPREME DIRECTOR — M194 CRM Operations

M194 extends the working, localhost-only M192 → M193 implementation. It is **new implemented software**, not the missing M180/M181 original tree. No production network access, payment processing, marketing messages, or physical device control.

## Delivered

- A dedicated Russian **Операции** section in the existing CRM Studio, using actual local API values.
- **CSV import**: exact `name,contact` schema, dry-run count, SHA-256 preview binding, ≤200 rows, duplicate prevention within tenant, atomic commit and request idempotency.
- **CSV export**: owner-only, tenant-scoped, neutralizes spreadsheet formula injection (note: exported formula strings are intentionally prefixed with an apostrophe).
- **Follow-up queue**: overdue/upcoming/unscheduled counts, upcoming horizon, priority ordering, rescheduling with optimistic versioning, and atomic bulk completion.
- **Pipeline metrics**: active pipeline value, won amount and closed-deal win percentage (not a forecast, no invented KPIs).
- **Security**: inherited M192/M193 bearer-token role and tenant checks, SQLite transactions, audit entries, same-origin Host/Origin protections, no credentials persisted by frontend.
- The earlier M193 locale route omission is corrected in M194: `/studio/ru.json` is served with same-origin protections.

## Start with a new database

From the `supreme-director` directory of the GitHub checkout:

```bash
PYTHONPATH=m192:m193:m194 python3 -m osgard_m194 init \
  --db /tmp/osgard-m194.sqlite --tenant "My Business" --actor owner
PYTHONPATH=m192:m193:m194 python3 -m osgard_m194 serve \
  --db /tmp/osgard-m194.sqlite --port 8714
```

Visit `http://127.0.0.1:8714/studio/`. The owner token is shown once by the CLI. Do not paste it in chats, commit it, or store it in screenshots. For an existing M192/M193 database, make a separate, verified backup first; `serve` only adds existing idempotent M193 schema and does not wipe client records.

## Test

```bash
export PYTHONPATH=m192:m193:m194
python3 m194/verify_source.py
python3 -m unittest discover -s m194/tests -p 'test_m194.py' -v
python3 -m unittest discover -s m193/tests -p 'test_m193.py' -v
python3 -m unittest discover -s m192/tests -p 'test_runtime.py' -v
node --check m194/osgard_m194/web/app.js
```

On the initial local build: 35 M194 tests + 40 M193 tests + 46 M192 tests = **121 passing** on Python 3.13. The browser automation environment refused access to localhost (`ERR_BLOCKED_BY_ADMINISTRATOR`), therefore visual browser QA **was not completed**. HTTP-route tests include locale, CSP, host validation and cross-site origin blocking.

## API

Send `POST /v1/execute` with JSON envelope `operation`, `payload`, `idempotency_key`, and `Authorization: Bearer TOKEN`. New operations:

| Operation | Role | Behaviour |
|---|---|---|
| `commerce.crm.import.preview` | owner/operator | Parse CSV, count duplicates, produce preview digest; no changes |
| `commerce.crm.import.commit` | owner/operator | Atomic insertion matching preview; requires idempotency key |
| `commerce.crm.export.csv` | owner | Export tenant's contacts with formula neutralization |
| `commerce.crm.followups.queue` | owner/operator/viewer | Read follow-up queue and counts |
| `commerce.crm.followups.reschedule` | owner/operator | Update due date using `expected_version` |
| `commerce.crm.followups.bulk_complete` | owner/operator | Atomic status changes of up to 50 activities |
| `commerce.crm.pipeline.metrics` | owner/operator/viewer | Actual local win rate and active pipeline values |

All new read/write operations are tenant-scoped. Failed write attempts do not add audit events or partial records. The API never sends emails, SMS or WhatsApp messages.

## Completion statement

- **M194 reference implementation**: tested, subject to GitHub CI and review.
- **Original historical 180 tasks**: 0 independently accepted; some functional subsets have *new code*, which must not be confused with completed original-team requirements.
- **Production release**: NO-GO; default GitHub `main` remains unchanged.
