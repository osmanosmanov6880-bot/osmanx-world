# OSGARD SUPREME DIRECTOR M192 - functional local runtime

This is executable code built from selected P0 requirements of the historical 180-task specification. It is not a replacement for the missing original upstreams and is not production-ready.

## What runs

- TITAN: tenant-safe task records, scoped token roles and write audit.
- COMMERCE: customer, deal and pipeline records in SQLite.
- EXPERIENCE: transactional slot booking, cancel, overlap checks and idempotency.
- NEXUS: persisted alternatives and rationale for decisions.
- GENESIS: versioned scene documents and immutable scene history.
- ORBITAL: isolated inert command simulator with TTL, nonce uniqueness, transport and execution ACK.
- HTTP API: JSON POST /v1/execute; GET /healthz; localhost only.

## Run and test

Python 3.11+ with standard library only:

```bash
cd supreme-director/m192
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 demo.py
python3 -m osgard_m192 --db ./local.sqlite init
python3 -m osgard_m192 --db ./local.sqlite provision --tenant Sandbox --actor local-owner
python3 -m osgard_m192 --db ./local.sqlite serve --port 8712
```

The `provision` command prints a newly generated bearer credential once. Treat it as a secret. An empty database cannot be called without a credential. To call the API, send Authorization: Bearer <token> and JSON with operation, payload, idempotency_key. Writes require a unique idempotency key. Example:

```bash
curl -sS http://127.0.0.1:8712/healthz
```

This package has no public network endpoints, no payment integrations, no remote agents, no arbitrary shell command runner and no real satellite interface.

## Security model and limitations

A tenant is inferred from the stored hash of the bearer token, never from a request payload. Operations have an allowlist of roles; unknown actions are rejected. SQLite transactions serialize writes and overlap checks. The API cannot issue tokens; only the local CLI can. Authentication is only suitable for local sandbox use: it lacks an external identity provider, key rotation UI, distributed rate limits, TLS termination, managed backup and security audit. Do not expose to a public IP address or use live personal data.

## Original project progress

These are new functional reference implementations based on selected P0 tasks, not historical upstream code and not independent acceptance of any of the original 180 assignments. The original acceptance counter remains 0/180, production remains NO-GO.
