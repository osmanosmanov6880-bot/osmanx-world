# OSMANX 1000 DOORS R5 — Staging & production acceptance guide

**Source-only gate.** Building and CI do not prove deployed Cloudflare infrastructure or a working physical phone.

## 1. Current product isolation

R1→R2→R3→R4→R5 are stacked PRs. `main` remains untouched; never merge R5 directly into main.

- R1 — Cinema, R2 — public route/data, R3 — editorial/D1, R4 — media/backup, R5 — tus/visibility and acceptance.
- Static site remains served by existing VPS. Cloudflare Worker is **only** `staging.osmanx.world/moscow-1000/api/*` in staging.
- Access must protect both `/moscow-1000/editor/*` **and** `/moscow-1000/api/admin/*`. JWT is verified independently by Worker.
- Do not copy production D1 (PII) into staging. Use empty distinct D1 database and private staging R2 bucket.

## 2. Migration and backups

Apply migrations `0001`, `0002`, `0003`, **`0004_r5_visibility.sql`** in order to the new staging D1. Back up the D1 database using Wrangler's remote export **outside the repo** before migrating a real environment. Then run:

```
node scripts/r5_d1_restore_drill.mjs path/to/private-D1-export.sql
```

It restores the SQL into local in-memory SQLite and checks integrity/FKs/schema and row counts; it never prints rows. An export is sensitive because it may contain subscriber addresses: do not commit or share it.

`node scripts/r5_d1_restore_drill.mjs` runs a synthetic migration + restore drill, **not** a real remote backup test.

## 3. Stream tus and approval

- Give Worker a `STREAM_API_TOKEN` secret. Configure `STREAM_ACCOUNT_ID`, `STREAM_CUSTOMER_CODE`; keep `STREAM_UPLOAD_ENABLED=false` until staging access and quota are approved.
- Browser uploads via tus 1.0.0, `HEAD` offset, `PATCH` chunks >=5 MiB (8 MiB default), max **5 GiB** or 60 minutes as our application policy (not claimed as Cloudflare limit).
- It can recover a lost connection **while the tab stays open**. Reloading the tab requires a new upload because upload URL is kept in memory only, reducing token leakage. No automatic video publication.
- `media_assets` tracks Stream UID, readiness and independent `rights_ref`; approval follows R4 two-person policy.
- `stream_visibility` outbox makes scheduled publishing fail closed until Cloudflare confirms public visibility. Cron retries failed jobs up to eight attempts, with a five-minute stale lease reclaimer.
- After eight failures, operator must investigate and manually address the incident; do not claim fully automatic healing.

## 4. Staging (manual, credentials required)

1. Create staging-only DNS route, Worker, Access app, D1, R2, Stream permissions, Turnstile and mail provider.
2. Configure copied **untracked** Wrangler configuration and secrets; do not send keys to chat.
3. Run strict preflight `node scripts/r5_preflight.mjs` and `node scripts/inspect_r4_config.mjs path/to/private/wrangler.toml`.
4. Apply migrations and verify a **synthetic** account, login and independent approver.
5. Run read-only remote check `node scripts/r5_staging_gate.mjs https://staging.osmanx.world/`. It checks 8 routes and rejects unprotected operator assets.
6. Run authorized human smoke: upload test footage through tus; interrupt/resume; verify code, review rights, approve; test direct Stream URL protection before publication; publish; confirm playback, remove and verify revoked URL. Use only consented synthetic contacts in forms and real opt-in and unsubscribe with approved test recipients.
7. Test Android + iOS devices separately on real cellular and Wi-Fi networks; check map provider compliance and responsive player. Keep copies of test evidence and rollback plan.

**No deploy is triggered by this project automatically.** Neither CI nor a local ZIP implies `osmanx.world` is running R5.

## 5. Merge/rollback

- Review PRs sequentially; merge R1 into main, rebase R2, merge R2, and repeat for R3–R5 only after each independent CI review.
- Before any production change: D1 export+offline restore, preserve the previous published static release, list Stream UID visibility and ensure moderator/approver Access works.
- During release, validate route, home page, episode, public data, protected operator area, actual playback and consent forms. Keep digest disabled until signed off.
- If failure: disable `STREAM_UPLOAD_ENABLED`/`DIGEST_DELIVERY_ENABLED`, close Access scope, unpublish erroneous episode, reconcile Stream privacy and restore previous static commit. **Revert D1 changes only from a tested export** and with explicit verification of newer data to avoid data loss.
