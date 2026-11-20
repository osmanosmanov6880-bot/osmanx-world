# OSMANX WORLD — 1000 DOORS / R4 TECHNICAL ACCEPTANCE

**Date:** 20 November 2026  
**Scope:** fifth? No — the **fourth** release cycle, following R3, comprising five complete source-code workstreams.  
**Integration:** stacked feature branch; do not merge out of order (R1 → R2 → R3 → R4). Existing osmanx.world and `main` not changed by local work.

## Completed implementation (five blocks)

1. **Staging isolation and preflight**: separate Wrangler staging template routes only `staging.osmanx.world/moscow-1000/api/*`, distinct D1 and private R2, Cloudflare Access/JWT role guidance, disabled real mail and upload switches, Node config validator, read-only HTTPS staging gate. No automatic deploy or credentials in code.
2. **Media Studio**: operator `media-studio.js` and Worker routes for one-time Cloudflare Stream creator upload URLs (MP4/WebM <=200 MB), encoding check, independent rights/consent/music review, Russian/English WebVTT upload, ordered chapter metadata, inline responsive Stream iframe for approved published clips. Stream video remains signed-only until editorial approval (or later scheduled release). Before a removed video disappears from approved release the Worker revokes its public Stream access. Staged AI videos remain separate from documentary episodes.
3. **Protected encrypted recovery**: AES-256-GCM encrypts editor-only snapshots into private R2. Recovery API supports listing, preview, authenticated and revision-safe restoration of **draft only**; public live data is not modified by draft recovery. Public `editorial_versions` history includes explicit rollback requiring version, reason, distinct approver if enabled, current rights/asset checks, new monotonic version and audited reason. PII leads and subscriber tables never included in these archives.
4. **Production calendar and SEO**: ten-day editable plan with optimistic versions, six preflight checks, independent schedule approval, cron-based release only if already approved media and actual public editorial episode exist, embargo filtering on public endpoint; no early digest. Static SEO generator emits VideoObject and sitemap entries only when a JSON input contains approved published documentary clips. No unapproved/future episodes are represented as published.
5. **R4 quality and mobile acceptance**: 18 new server/integration tests plus 36 inherited tests = **54/54 success**. SQLite temporary DB with 0001–0003 migrations; cryptographic JWT mock, mock Cloudflare Stream and encrypted in-memory R2, conflict tests, end-to-end API route checks, safe Stream revocation. Playwright+Chromium source-injection smoke at 390x844 / 1440x900 with mocked data checks editor tabs, Stream embed, chapters, no fake metrics and no page JS errors. Dedicated PR CI includes syntax, full Node regression and privacy checks.

## Commands and verification

```sh
node --test tests/moscow-1000-r1.test.mjs tests/moscow-1000-r2.test.mjs tests/moscow-1000-api.test.mjs tests/moscow-1000-r3.test.mjs tests/moscow-1000-r4.test.mjs
python3 tests/smoke_r4_browser.py
python3 tests/smoke_r4_static_server.py
```

Results: 54/54 Node passes; browser source-injection **PASS**. Local HTTP navigation **SKIP**, not PASS: Chromium blocked `127.0.0.1` with `net::ERR_BLOCKED_BY_ADMINISTRATOR` in this execution environment. Real HTTP/HTTPS staging has **not** been accepted.

## Untested/blocked production requirements

- Cloudflare account, Stream customer code, Stream API token, staging D1 (migration 0003), R2 private bucket, Cloudflare Access application, Turnstile/Resend not connected. Thus actual upload, video encoding, public CDN, real mail, Access authentication and backup storage are not demonstrated by mocks.
- Public HTTPS route, Nginx serving of newly added files, actual SEO crawler behavior, original production media playback and staging DNS not verified. Cloudflare documentation confirms Stream creator uploads and scheduling; this is not evidence of this deployment.
- No documentary source video provided. Ten expedition documentary episodes remain **planned**. No factual B2B results, business point data, customers, proposals or actual sales were invented.
- No real Android/iOS physical-device tests. Chromium tests were emulated viewport only. Real OSM tile loading and hosted forms were not tested this cycle.
- The <=200 MB uploader uses a basic POST; it is not resumable. For larger footage use Cloudflare Stream tus and more E2E before declaring production readiness.
- AES-GCM copies include internal editorial evidence references but NOT general D1 subscriber/lead records. Full D1 disaster recovery requires separate secure `wrangler d1 export` with tested restoration and appropriate PII controls. Loss of encryption key makes R2 archive unreadable.
- Scheduled release can be delayed by Cron. The public API only shows episodes when the stored schedule changes to `released`. Older staged local MP4 static URLs are not embargo-protected by the calendar; use restricted Stream for embargoed content.
- A failed Stream revoke after public publication removal results in API status 207 and `retiredStreamRevoked:false`; manual incident response must check direct URLs and Cloudflare settings. Automatic retry/reconciliation is future work.

## Next five tasks (R5 proposal)

1. Real staging Cloudflare Access and isolated D1/R2/Stream bindings, database migration/restore drill.
2. Large-file resumable tus uploads, poster overrides, verified subtitles/rights lifecycles.
3. Independent release approvals and failure reconciliation for cross-service Stream/D1 operations.
4. Hosted HTTPS user-flow E2E with real consent, Turnstile, Resend and security/performance verification.
5. Physical Android/iPhone acceptance, stepwise PR merge R1→R4, monitored production rollout with rollback rehearsed.
