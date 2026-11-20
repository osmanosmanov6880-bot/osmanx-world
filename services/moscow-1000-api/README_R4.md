# R4 / Private Media Studio + Editorial Archive + Release Calendar

**Status:** code implemented and tested with SQLite/Chromium mocks; no Cloudflare account, Stream asset, D1 database, Access app, R2 bucket, or Resend credentials were connected by this source-only release.

## Separate staging environment and deployment

- Use only a dedicated `staging.osmanx.world` DNS/Cloudflare route and **new** staging D1 and R2 resources; do not repurpose the production Worker or use existing production credentials.
- Prepare a private, local `wrangler.toml` from `wrangler.staging.toml.example` (do **not commit** it). Run `node scripts/inspect_r4_config.mjs services/moscow-1000-api/wrangler.toml` from repository root. Production route, disabled flags set to true, missing identifiers and secrets committed in config are blocked by preflight.
- Bind a staging-only Cloudflare Access application to `/moscow-1000/editor/*` (all static editor files) AND `/moscow-1000/api/admin/*`. The Worker independently verifies RSA JWT signatures and audience. Editor and approver should be separate human identities (`REQUIRE_TWO_PERSON_REVIEW=true`).
- Apply migrations 0001, 0002 and 0003 *in order* to the distinct staging D1. For example `npx wrangler d1 execute osmanx-moscow-1000-staging --remote --file=migrations/0001_init.sql` (run in service directory with authenticated Wrangler), then 0002 and 0003. Before any future production migration, take an independent D1 export and test restoration; this project's encrypted editorial backup is **not** a full D1 backup.
- Bind private R2 `BACKUP_BUCKET` and 32 random bytes base64 `EDITORIAL_BACKUP_KEY`. Never expose key on frontend; store the key securely outside the bucket. Loss of the key makes all backups unreadable.
- Configure Cloudflare Stream account/customer code and Stream Write API token in Worker secret `STREAM_API_TOKEN`. Only after Access, D1, rights and upload quota checks, intentionally flip `STREAM_UPLOAD_ENABLED=true` in staging. For MP4/WebM <=200MB a one-time direct upload URL is supported. Larger/unstable transfers need tus integration before acceptance; do not misrepresent current POST as resumable.
- For real audience forms, supply independent staging Turnstile and verified Resend secrets, and test real double opt-in and unsubscribe. `DIGEST_DELIVERY_ENABLED` must remain `false` until signed-off. Do not use real customer lists for staging.
- On actual staging run `node scripts/check_r4_staging.mjs https://staging.osmanx.world/`. Read-only gate checks public metadata + unauthorized editor/admin URLs; it does not prove Access works for permitted users, delivery or phone playback. Those require controlled live accounts and human test.
- This repository's CI is **validation only**, no automatic Worker deployment.

## Private API additions (only signed Access JWT and same-origin JSON mutations)

| Route | Role | Behavior |
|--|--|--|
| GET `/admin/media` | editor/approver | Lists no public subscriber or CRM data |
| POST `/admin/media/upload` | editor | Validates MP4/WebM <=200MB, requests one-time signed-only Stream upload URL |
| POST `/admin/media/:id/sync` | editor/approver | Checks actual Stream ready state |
| POST `/admin/media/:id/captions` | editor | Validates and uploads WebVTT in ru/en |
| POST `/admin/media/:id/chapters` | editor | Saves sorted chapters |
| POST `/admin/media/:id/approve` | approver | Independent review of consent, rights and music after ready |
| GET `/admin/calendar` | editor/approver | Reads 10-day release planning |
| PUT `/admin/calendar/:day` | editor | Optimistic versioned update |
| POST `/admin/calendar/:day/approve` | approver | Requires all six checklist items plus documentary episode in draft |
| POST `/admin/calendar/:day/cancel` | approver | Cancels only not-yet-published schedule |
| GET/POST `/admin/backups` | approver | Lists/creates encrypted editorial-only R2 snapshots |
| GET `/admin/backups/:id/preview` | approver | Summary of encrypted archive, no draft contents |
| POST `/admin/backups/:id/restore` | approver | Optimistic restore of **draft only**, never silently publishes |
| GET `/admin/versions` | approver | Reviewed public snapshots |
| POST `/admin/versions/:version/rollback` | approver | Requires explicit reason, current version check and re-verification of videos/rights; creates a *new* revision |

A `stream:<32hex>` reference in the existing editorial episode model is accepted only after media approval. Approved Stream videos are initially signed-only. For scheduled releases a periodic Worker checks due date and published approved episode before toggling Stream public access. Public GET still filters by calendar status; planned previews cannot be confused with released videos. Local `/assets/*.mp4` releases retain R3 HEAD checks and are not embargo-secured: do not upload local assets before public release if secrecy is required.

## Backups and privacy boundaries

- AES-256-GCM encrypts only `editorial_draft` (including private evidence references) and minimal version metadata; **leads, private contact names, subscribers, tokens, API keys and raw unreviewed footage are NOT included**.
- Staging/production snapshots stored in distinct private R2 buckets. Use Cloudflare's own D1 export/backups separately for full disaster recovery. Restoring a draft leaves current approved public release intact.
- Release version rollbacks are manually confirmed, audited with a reason and new monotonic version; they do not erase the superseded version. If rights were revoked, operator should unpublish instead.
- Do not publish names, personal coordinates, interviews, customer PII, raw evidence or rights references without a specific legal basis/approval.

## SEO publication

`node scripts/build_r4_seo.mjs verified-public-release.json build-preview/`

The command emits 10 static episode pages plus a sitemap in a local preview directory. **Only approved documentary episodes** get a VideoObject and sitemap entry. This is an export/pre-render process; it does not mutate the live VPS, and a generated file is not proof of SEO indexing. Use only a public-release JSON obtained from the actual, approved API **after** scheduled release, not editorial drafts.

## Acceptance

`node --test tests/moscow-1000-r1.test.mjs tests/moscow-1000-r2.test.mjs tests/moscow-1000-api.test.mjs tests/moscow-1000-r3.test.mjs tests/moscow-1000-r4.test.mjs`

`python3 tests/smoke_r4_browser.py` uses Playwright + locally available Chromium and MOCKED network. For live acceptance, test verified editor login, a real video upload, rights approval, its published playback, live D1 archive/restore, scheduled release, manual unsubscribe, valid email deliverability, physical Android/iOS, HTTPS CSP, map tiles, consent and rollback. Do not merge stacked branches directly into `main` until R1/R2/R3 are reviewed in order and R4 staging gate succeeds.
