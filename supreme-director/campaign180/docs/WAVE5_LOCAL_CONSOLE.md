# Original 180 — Wave 5: local authenticated editor, workflows and RBAC

Related to TITAN-X22 (API/workflow visual constructor) and TITAN-X23
(app permission policies). Code is a standalone **local** integration harness,
not an independent acceptance of KRAKEN/NEXUS/Command original upstream.

## What works

- `app_policy.py` keeps member roles per tenant+project (owner/editor/
  operator/viewer), explicit one-time trusted owner bootstrap, owner-only
  delegation and revocation. No implicit membership across projects.
- `app_runtime.py` protects page edits, typed CRUD, workflows and preview
  at the **same SQLite transaction** as access checks, preventing
  read-authorize-write time-of-check/time-of-use races.
- A deterministic workflow rule has exact schema, model, manual or explicitly
  named trigger, optional condition and one literal `set_field` action.
  Runs are idempotent by UUID and event digest and cannot call the network,
  run scripts, change relations or trigger themselves automatically.
- `local_http.py` is a WSGI JSON API bound to **127.0.0.1** only, with an
  explicit server-side principal, no cookies or CORS, strong bearer token,
  restricted Host/Origin/remote IP, max 64 KiB JSON bodies, duplicate-key
  rejection and safe generic errors. No login form or external identity
  provider is provided.
- `assets/` is a working dark Russian-language, mobile-responsive local
  console with pages, typed record editing, workflow creation/launch and a
  sandboxed static preview. Token is held in an in-memory JS variable and is
  never put into localStorage/cookies, query string or generated HTML.

## Reproduce in an isolated local Python environment

Run from repository root using Python 3.11+:

```bash
export PYTHONPATH="$PWD/supreme-director/campaign180"
python -m campaign180.local_http init \
  --database /tmp/osgard-console-demo.sqlite3 \
  --spec supreme-director/campaign180/examples/demo-site.json \
  --actor owner-abc

# Generate a 256-bit+ token securely. Never commit or publish it.
export OSGARD_LOCAL_API_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(40))')"

python -m campaign180.local_http serve \
  --database /tmp/osgard-console-demo.sqlite3 \
  --tenant tenant_demo \
  --project-id 0b83c3f2-b4ab-4a6f-a83e-a48cb39b9c6f \
  --actor owner-abc --port 8765
```

Open `http://127.0.0.1:8765/console` in a browser **on the same local
machine** and provide the environment token in the access prompt. Do not
forward port 8765, bind any other network address, or run on shared
production hosts. The token authorizes all capabilities of the server-bound
principal; never reuse a production secret. Environment variables may be
readable by privileged local processes, so treat this setup as a single-user
development tool, not hardened multi-user authentication.

Tests:

```bash
PYTHONPATH=supreme-director/campaign180 python -m unittest discover \
  -s supreme-director/campaign180/tests -p 'test_*.py' -v
node --check supreme-director/campaign180/assets/console.js
```

## Limitations and next independent gates

- Does not support TLS, production identity providers, real customer sign-in,
  signed scopes, hosted tenants, automated workflow event subscriptions,
  external webhooks, code execution or billing.
- Rules only run when explicitly invoked; a trigger name is a declared
  category, not proof an event subscription is installed.
- The visual editor is functional for the supported fixed section types,
  but lacks drag-and-drop, rich asset management and true collaborative editing.
- No production server, production backups or production data used.
- Six upstream owner-approved repo/SHA pairs and independent acceptance
  are still missing. Original independently accepted tasks: **0/180**.
  Merging into main or deploying production remains **NO-GO**.

Rollback: revert only these isolated commits in the Draft PR. Local demo data
can be discarded after confirming it resides in an isolated scratch path.
