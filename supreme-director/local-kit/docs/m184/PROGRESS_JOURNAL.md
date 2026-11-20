# OSGARD M184 -- actual engineering progress journal

All facts below refer to local Director Studio, not production integration.

## Source reconstruction

- Read original M183 ZIP in the active container. SHA-256: `c48e2996016ca61a9846c74c72dfdfa20c6b28386ab2ec72e5a10d59fee6cbde`; preflight 188/188 from M183.
- Cloned the actual local tooling Git repository at M183 commit `9d45e11342ecd0640b1de5ce36d0943ed9910f3f`. The new M184 change is an extension of **tooling lineage only**, not M180/M181 product code.
- Original M181 ZIP pinned SHA `c6d0ff3ff9caa435e6928244ab70ecee8156747306ac3174faca82702be2969a` remains unavailable.

## Block 1 -- functional control plane

- `osgard_m184/storage.py`: real SQLite data for the 180 proposed task IDs and 174 proposed edges, 28 unresolved provisional conflicts (17 P0 + 11 P1), nine UNVERIFIED contract slots, six teams, unassigned Git snapshots.
- Tasks are invariant `NOT_ACCEPTED`, contracts `UNVERIFIED`, source observations `UNVERIFIED`. No route exists to make a production approval. Added local note and conflict triage actions with transactional audit hashes.
- `osgard_m184/api.py`: real local HTTP backend, strict loopback host, ephemeral bearer token, JSON size caps, origin and no-CORS protections, safe static content, strict CSP.
- `osgard_m184/cli.py`: bootstrap, doctor, serve, summary, note and evidence-register commands; Windows and shell launchers.

## Block 2 -- premium, functional UX

- `dashboard/m184/studio.html`, `studio.css`, `studio.js`: responsive midnight-blue and gold command console, six live tabs, search/filter, local task notes, conflict triage, source observations, audit verification and JSON export.
- User interaction is wired to the actual SQLite API. No generated decorative mock dashboards were counted as product completion.
- Browser QA at 1440, 390, 320 px: no JS exceptions and no horizontal overflow. Real backend operations passed over the documented Playwright-to-Python HTTP bridge.

## Block 3 -- failures kept and corrected

- First browser attempt: Chromium refused direct localhost URL (`ERR_BLOCKED_BY_ADMINISTRATOR`), a testing-environment restriction. HTTP API independently tested using Python's HTTP client. Browser used an explicitly documented transport bridge, not an unreported fake network success.
- Second attempt: selector matched doctor-status toast and output simultaneously. Refined selector to uniquely identify the actual doctor output.
- Third attempt: test reused a conflict previously moved to TRIAGED, so the fixture correctly prohibited repeating the transition. Allocated distinct conflict IDs per viewport.
- Original test suite emitted unclosed-connection ResourceWarnings in some inherited legacy tests; investigated and recorded, without hiding a production issue by relabeling warnings as failures. New M184 database tests use explicit connection closure.

## Block 4 -- verification and resilience

- New local storage/API positive and negative tests: 64/64 PASS; deterministic packaging tests: 10/10 PASS.
- Combined inherited M183 (188) + new M184 (64) + packaging (10): 262/262 PASS.
- Three browser sizes; each ran live data connection, filtered 30 tasks, posted a note, triaged a distinct conflict and verified the audit result. 3/3 PASS.
- Real SQLite online backup restored synthetic note/triage state: PASS. No production RTO/RPO was measured.
- Single-process sequential loopback HTTP diagnostic: 160 requests, locally measured; explicitly not an SLO, load-test or real-user performance proof.

## Reproducible distribution fix

- First archived-source QA revealed that a packaging test expected `.git` metadata, which a normal downloaded ZIP does not contain. Initial unpacked QA correctly failed.
- Updated `build_payload` to discover files from the verified `MANIFEST.json` when Git is unavailable; each file is re-hashed. This protects portable verification while retaining deterministic Git-tree packing where available.
- The failing first attempt is preserved as an external log; final unpacked verification must pass before shipping.

## Current blockers and non-claims

- `0/6` canonical six-team upstream repositories independently confirmed.
- `0/180` original tasks independently accepted; the in-app 180 IDs are a separate provisional plan.
- `28/28` actual source conflicts unresolved and all nine real API contracts untested.
- No functioning six-product flow, production identity, external security audit, international paying clients, physical mobile QA or product reliability certification.
- `PRODUCTION_NO_GO` and external GitHub product branches remain unchanged.

## Program next actions

See `IMPLEMENTATION_AND_ACCEPTANCE_PLAN.md` for complete M185-M192 go/no-go gates. Immediately prioritize pinned original M181 bytes, owner-confirmed upstream references, independent review of actual 28 conflicts and real contract E2E; do not substitute a prettier console for product completion.
