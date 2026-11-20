# OSMANX WORLD — 1000 DOORS R5 / ENGINEERING ACCEPTANCE

Date: 2026-11-20. R5 built on R4, in a distinct feature branch, without modifying production.

## Five fully implemented engineering workstreams

1. **Safe staging gate:** `scripts/r5_preflight.mjs` rejects missing R5 files, unsafe production targets and accidental local secrets. `scripts/r5_staging_gate.mjs` performs eight **read-only GET** checks on `https://staging.osmanx.world/` only: pages, health, public JSON privacy, Access protection of editor assets/admin API, and hidden config. Actual Cloudflare credentials were unavailable; no remote deployment or live passes claimed.
2. **Stream tus direct-creator ingest:** authenticated `POST /moscow-1000/api/admin/media/tus` provisions a signed-only upload with `Upload-Length`, `Tus-Resumable:1.0.0` and constrained metadata, validates returned `Location` and `stream-media-id`, and stores a pending media row. `moscow-1000/editor/tus-client.js` uses `HEAD` offset followed by 8 MiB `PATCH` slices, pause/resume after interruptions, accessible progress and fixed limit 5 GiB/1h. API secret never reaches browser. Browser URL is deliberately held **in memory only**, so reload requires a new session. Real Cloudflare tus CORS/production ingestion remains unverified.
3. **D1/Stream consistency:** schema `0004_r5_visibility.sql` adds stream visibility outbox. Scheduled releases update D1 state and queue Stream intent transactionally; public endpoint filters a queued/failed Stream video until the external API has confirmed visibility. Cron checks failed/pending jobs with bounded retries and a five-minute stale-lease threshold. Unpublish and retired clips enqueue visibility repair when needed. Media signing and independent approval remain from R4. After retry exhaustion operator action remains required.
4. **D1 restore rehearsal & production runbook:** `scripts/r5_d1_restore_drill.mjs` loads real SQLite-compatible D1 SQL into an isolated in-memory DB and checks integrity, FKs, schema and table row counts without printing personal rows. Synthetic migration-only rehearsal is also available. `services/moscow-1000-api/README_R5.md` documents separate staging resources, Cloudflare Access, Wrangler D1 export, actual human consent/Turnstile/Resend checks, sequential stacked PR merging and rollback.
5. **QA and mobile acceptance:** `tests/moscow-1000-r5.test.mjs` adds **18** tests covering unsigned authorization, bad upload hosts, tus behavior, interrupted retries, D1 visibility, queued publication and failure/reconciliation, staging gate and restore drill. Prior R1–R4 **54** tests stay green, total **72/72 local Node tests**. `tests/smoke_r5_browser.py` Chromium source injection passes **390×844 and 1440×900**, including real browser File slicing, mocked tus HEAD/PATCH failure then resume, progress and absence of horizontal scrolling or JS errors. Dedicated `moscow-1000-r5.yml` CI repeats the Node suite and static safety gates.

## Honest limits

- No authenticated Cloudflare account or secrets were provided. Live staging, real Stream upload, Turnstile, Resend, D1 and R2 bound resources, physical Android/iOS, and remote HTTPS browsing were **not** tested.
- No video of the Moscow expedition was supplied, and no actual verified B2B metrics were published. R1–R4 original documentary episodes remain unfilmed unless independently uploaded and verified.
- The current resume capability works within the active browser tab only, because saving the upload URL to localStorage would expose a bearer capability. It does **not** recover upload sessions after browser restart.
- Node SQLite tests exercise a D1-compatible local implementation, not Cloudflare's distributed runtime. Stream HEAD/PATCH responses and API token behavior are mocked.
- Outbox repair is bounded to 8 attempts; after repeated failure, an operator must resolve it. Previously leaked direct Stream URLs need deliberate rights/security review.
- Staging gates need full editor Access policy, not just JWT verification of API, and the static VPS deployment may require Nginx routing for `/moscow-1000/episodes/xx/`.
- No merges or changes to `main` are authorised by this delivery; production deployment deliberately left blocked.

## CI/test commands

```sh
node --test tests/moscow-1000-r1.test.mjs tests/moscow-1000-r2.test.mjs tests/moscow-1000-api.test.mjs tests/moscow-1000-r3.test.mjs tests/moscow-1000-r4.test.mjs tests/moscow-1000-r5.test.mjs
python3 tests/smoke_r5_browser.py
node scripts/r5_preflight.mjs
node scripts/r5_d1_restore_drill.mjs
# Credentials and deployed staging required; NOT run in this release:
node scripts/r5_staging_gate.mjs https://staging.osmanx.world/
```

## Next five priorities (R6)

1. Provision an actual isolated Cloudflare staging Worker/D1/R2/Access/Stream and verify Worker/API host routing.
2. Confirm real Stream tus CORS, upload resume on 4G, delayed encoding and signed playback (not only mocked responses).
3. Introduce an operator incident screen for the outbox, manual retry with two-person authorisation, and alerting on exhausted jobs.
4. Exercise remote D1 export/restore with an explicit PII-safe procedure and independently reviewed disaster-recovery time objectives.
5. Physical Android/iOS accessibility & bandwidth acceptance, sequential PR review/merges and rollback rehearsal before any production switch.
