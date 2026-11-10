# M184 operator runbook (safe local use)

1. Unpack the verified M184 ZIP into an empty folder. Install Python 3.13 (stdlib only for the app); no cloud service is needed.
2. Run `START_OSGARD_STUDIO_WINDOWS.cmd` on Windows, or `sh START_OSGARD_STUDIO_LINUX_MAC.sh` on Linux/macOS.
3. Open `http://127.0.0.1:8765/` on the **same computer**, paste the temporary token printed in the terminal. Never paste a token into a chat or repository.
4. Check Overview, Task board, Conflict room, API contracts, Source ledger, Audit trail. Note and triage actions write to `runtime/m184_local.sqlite3` only. They do not change `NOT_ACCEPTED`, canonical source assignments, approval, deployment or production data.
5. Ctrl+C stops the local server. Backup the SQLite file via SQLite's built-in online backup API if the application has been used; for local development, stop the server before manually copying files. Guard the copied DB as internal data.

## Manual launch and read-only verification

```sh
python3 -m osgard_m184 bootstrap --db runtime/m184_local.sqlite3 --plan docs/M182_WORKPLAN_180_PROPOSED.json --conflicts templates/CONFLICTS_PROVISIONAL.json --contracts templates/CONTRACTS_PROVISIONAL.json --observations docs/m183/CURRENT_GITHUB_DEFAULT_BRANCH_OBSERVATIONS_2026-10-27.json
python3 -m osgard_m184 doctor --db runtime/m184_local.sqlite3
python3 -m osgard_m184 serve --db runtime/m184_local.sqlite3 --port 8765
```

## Real tests and recoverability

```sh
python3 -m unittest discover -s tests -q
python3 scripts/recovery_m184.py
python3 scripts/benchmark_m184.py
python3 scripts/qa_m184_browser.py
```

`qa_m184_browser.py` requires Playwright and the Chromium binary and, in this restricted environment, uses an in-process Playwright-to-Python HTTP bridge because Chromium localhost navigation is administratively blocked. The HTTP API is separately tested using actual Python HTTP requests. Do not mislabel this as unbridged browser-to-loopback E2E.

## Non-negotiable security boundaries

- The web listener binds only `127.0.0.1`; no TLS, accounts, RBAC, cloud production endpoint or multi-tenant isolation is provided. The token is a local bearer secret with session-memory browser storage only.
- Do not port-forward, reverse-proxy or expose this app. Do not put production credentials, personal customer data, payment information or proprietary source code into freeform notes.
- `audit.event_sha` is an integrity check of local state only: a privileged filesystem adversary can rewrite an SQLite file and recompute its hash chain. This is NOT external signature custody.
- Original M181/source conflicts/contracts absent; imported IDs remain provisional, and all nine contracts remain UNVERIFIED. Only a verified original source + independent human reviewer can begin formal acceptance.
- Recover on an isolated copy, never mutate an original source ZIP, and keep production STOP until independent technical/operational approval.
