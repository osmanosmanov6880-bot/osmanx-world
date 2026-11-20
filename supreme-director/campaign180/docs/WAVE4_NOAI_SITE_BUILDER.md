# TITAN X17/X20/X21/X24/X25 — no-AI editor with local preview

This Wave 4 contains an actual **offline runnable vertical slice**, not a
mockup or an AI-dependent scaffold. It is deliberately NOT an integration into
the original KRAKEN/NEXUS/Command products; independent acceptance stays 0/180.

- `builder.py`: strict versioned JSON site specification, up to 8 pages
  with hero/text/features/stats/contacts/table sections, typed models and
  relationship metadata; deterministic XSS-escaped responsive HTML/CSS,
  static strict CSP/noindex, no script execution or network references.
- `drafts.py`: tenant+project-scoped SQLite drafts, immutable revision log,
  compare-and-swap edit, section/title editing, new-revision rollback, and
  checksummed canonical import/export to a NEW project only. Live records
  and credentials are never exported. Model changes with records are denied
  until a separate reviewed migration exists.
- `records.py`: local typed CRUD, bounded pagination, same-tenant/project
  reference integrity, unique idempotency keys and per-record revision CAS.
  Deletion is refused while a row is referenced. Records are not reachable
  through a public web API.
- `preview.py`: renders isolated static HTML pages into a NEW directory
  only, verifies SHA-256 manifest, refuses symlinks/unlisted files and will not
  overwrite an existing preview. It does not start a server or deploy.
- `examples/demo-site.json`: Russian-language three-page, two-model demo.

Reproduce on Python 3.11+ from repository root:

```bash
export PYTHONPATH="$PWD/supreme-director/campaign180"
mkdir -p /tmp/osgard-preview-output
python -m campaign180.preview build supreme-director/campaign180/examples/demo-site.json /tmp/osgard-preview-output demo-run
python -m campaign180.preview verify /tmp/osgard-preview-output/demo-run
python -m unittest discover -s supreme-director/campaign180/tests -p 'test_*.py' -v
```

Local safety constraints: all privileged library functions must be called
only by a trusted local orchestration layer; there is no external
authentication, no live forms, no network API, no physical sandbox
acceptance, no distributed lock or backup configuration for this draft
database. Generated HTML is view-only until application-level validation
and hosting are independently implemented. Never publish to production from
this module. Roll back by reverting this branch commit; test SQLite DBs
and preview directories can be discarded only in isolated scratch environments.
