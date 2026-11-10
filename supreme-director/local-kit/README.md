# OSGARD M186 — Integration Lab / Director Studio

**REAL LOCAL APPLICATION + DETERMINISTIC REFERENCE ADAPTERS / 0 REAL PRODUCT INTEGRATIONS / 0 OF 180 INDEPENDENT TASK ACCEPTANCES / PRODUCTION NO-GO**

M186 extends the independently rechecked M185 Signed Review Studio. It is a functional local tool: nine versioned, strictly typed *reference-only* contracts, a nine-stage scenario runner, a SHA-256-chained immutable SQLite run ledger, a fail-closed schema-fault test, a loopback HTTP API and a responsive dark/gold GUI. There are no calls to the actual TITAN/KRAKEN, NEXUS, COMMERCE, HUMAN EXPERIENCE, GENESIS MEDIA or ORBITAL products.

## One-click launch

- **Windows:** install Python 3.13 and `py -3.13 -m pip install -r requirements-m185.txt`, then double-click `START_OSGARD_M186_WINDOWS.cmd`. A private temporary token is printed in the local terminal.
- **Linux/macOS:** `python3 -m pip install -r requirements-m185.txt`, then `./START_OSGARD_M186_LINUX_MAC.sh` (or use a virtual environment).
- Open `http://127.0.0.1:8765/` **only on that computer**, paste the bearer token, and open **Integration Lab**. Select a synthetic scenario and click **Execute 9-stage reference flow**.
- Select `CONTRACT-05` under deliberately broken contract to verify that one bad stage terminates the flow. The failure is persisted, not hidden or turned into a PASS.

Never use real identity information, business data, payment information, private keys, or production credentials in the synthetic scenario form. The server binds to loopback and is unsuitable for a VPS or public Internet exposure.

## Reproducible command-line verification

```bash
python3 -m osgard_m186 init
python3 -m osgard_m186 run --scenario LEARNING_PLATFORM --operator local-operator --budget-points 1200
python3 -m osgard_m186 doctor
python3 -m unittest discover -s tests -q
```

Fresh data files are created under `runtime/` and are excluded from delivery. Do not alter the historical `templates/CONTRACTS_PROVISIONAL.json` status `UNVERIFIED`. M185 review keys remain operator-provided and no synthetic signing keys are shipped. `python3 -m osgard_m185 ...` still supports the original signed local evidence workflow.

## Verifiable outputs and architecture

- `osgard_m186/contracts.py`: fixed reference adapter routes, strict schemas, no external services, no payment or production approvals.
- `osgard_m186/storage.py`: append-only local run ledger, cross-event SHA checks, deterministic replay and tamper detection. A local DB administrator can still rewrite both DB and local code; **not external attestation**.
- `osgard_m186/api.py`: authenticated loopback routes `GET /api/v1/lab/catalog`, `GET /api/v1/lab/runs`, `GET /api/v1/lab/runs/{id}`, `POST /api/v1/lab/runs`.
- `dashboard/m186/`: real responsive interface, wired to API and local SQLite with positive and negative Chromium/browser test evidence.
- `templates/REFERENCE_CONTRACTS_M186.json`: separate simulation catalog, not the nine originally proposed production contracts.
- `docs/m186/`: operator runbook, source and contract boundaries, 180-task master roadmap and progress journal.
- `evidence/m186/`: raw test results, synthetic local run proof, browser viewport screenshots and parent ZIP provenance.

## Why product release is still blocked

The original M181 ZIP and exact Git ancestry, owner-confirmed upstream repos for six systems, 28 actual code-conflict decisions, live nine-contract producer/consumer tests, independent reviewers and production-grade security/operational checks remain absent. The 180 planned tasks stay `NOT_ACCEPTED` and production stays `NO_GO`. A reference adapter passing is a test of the harness, not proof of a real adapter or user-visible product.

Follow the **block-by-block completion plan** in `docs/m186/MASTER_PLAN_TO_WORLD_CLASS_RU.md` before attempting any release action.
