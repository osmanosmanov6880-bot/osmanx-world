# OSGARD SUPREME DIRECTOR - M193 CRM Studio

M193 is new functioning code built on, not a replacement for, M192.

This is a **localhost-only, offline reference implementation**, not the missing M180/M181
source tree. It does not deploy, charge money, send messages or control devices.

## Features

* 6 existing M192 domains remain available through the same JSON API.
* New tenant-scoped CRM: customer editing, optimistic record versions, deal stages,
  follow-up activities, completion and pipeline reporting.
* Same-origin Russian Studio served from the local API; no CDN or fake metrics.
* Owner/operator can write; viewer is read-only. Credential remains in browser
  memory and is discarded on page reload, not persisted to localStorage.
* New CRM writes use M192 transactions, audit and shared idempotency namespace.
* Existing M192 databases can be upgraded in place; new tables do not destroy data.

## Run locally

From `supreme-director` in the GitHub checkout:

```bash
PYTHONPATH=m192:m193 python3 -m osgard_m193 init --db /tmp/osgard-m193.sqlite --tenant "Local Business" --actor owner
PYTHONPATH=m192:m193 python3 -m osgard_m193 serve --db /tmp/osgard-m193.sqlite --port 8713
```

Open `http://127.0.0.1:8713/studio/` and enter the one-time local token
shown when the database is first created. Keep tokens private; do not save them
in issue comments, Git commits or screenshots. Setup refuses to overwrite a
pre-existing database.

## Verification

```bash
PYTHONPATH=m192:m193 python3 -m unittest discover -s m193/tests -v
PYTHONPATH=m192 python3 -m unittest discover -s m192/tests -v
node --check m193/osgard_m193/web/app.js
```

No production release is authorized. Original 180-task independent acceptance
remains 0/180. M193 delivers newly implemented subsets of COMMERCE-X06/X07 and
EXPERIENCE/TITAN integration in an offline sandbox; it is not proof the original
independent product upstreams were integrated.

## Protocol

Existing API: `POST /v1/execute` with JSON fields `operation`, `payload`,
`idempotency_key` and `Authorization: Bearer <token>`.

Added operations:

- `titan.session.get` (read)
- `commerce.crm.customers.list` (read), `.update` (write)
- `commerce.crm.deals.list` (read), `.update` (write)
- `commerce.crm.activities.create` (write), `.list` (read), `.complete` (write)
- `commerce.crm.overview` (read)

All writes require a unique idempotency key of 8-100 allowed characters.
Optimistic updates require `expected_version`; stale writes return `Conflict`
(HTTP 409). For deal stages the allowed forward transitions are:
`new -> qualified -> proposal -> won`, with `lost` allowed from all unfinished
stages. Terminal deals cannot be reopened by this API.

The local web server only binds to loopback, enforces Host/Origin checks, and
serves a finite static-file allowlist. No browser CORS privileges are granted.
