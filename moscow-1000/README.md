# OSMANX ORIGINALS — 1000 ДВЕРЕЙ (R2)

Extends R1 without replacing the existing OSMANX STORIES staged film or the closed personal CRM.

## Public site

- `/moscow-1000/`: cinema page, 10 documentary episode cards (initially planned, no fake video), public map, approved metrics, existing clearly labeled staged OSMANX STORIES MP4, partner/business/research outreach.
- `/moscow-1000/episodes/01/` … `/10/`: individual searchable planned episode pages, public day-area link, factual notes only after approval.
- `/moscow-1000/geo.js` + `map.js`: 10 day clusters, two approximate public geographical anchors per day, interactive OSM tiles, pan, zoom, keyboard controls, day filters, accessible list, OSM attribution. **No private locations, no fake businesses, no walking route calculations.** Map list works when network imagery does not.
- `publication.js` + `public-r2.js`: explicit published status, seven funnel indicators, editable day notes after an independent manual approval gate. Initial display is **No data**.
- `intake.js`: same-origin `/moscow-1000/api/health` capability check; if unavailable, HTML forms remain hidden and clearly labeled `mailto:` alternatives remain usable. Never claims a successful send without a Worker response.

## Private form service (NOT live yet)

`services/moscow-1000-api/` is intentionally outside the static deployment whitelist. It contains a Cloudflare Worker with separate D1 storage, server-side Turnstile validation, Resend notification, email double opt-in, safe GET/POST confirmation and unsubscribe flow, and retention cleanup. Real forms require separately deploying the Worker, database migrations, a Turnstile widget and mail provider credentials. See service README.

**No** user data is sent to this prototype unless the Worker is explicitly deployed with all bindings and website proxy/route configured. No live status or delivery is claimed.

## Local preview

For visual checks run an HTTP static server from the package root (`python3 -m http.server 8080`) then open `/moscow-1000/`. The map needs Internet access for OSM imagery. The included QA script runs Chromium with source injection because its sandbox blocks HTTP/file navigations; its tile backdrop is a test stub, not a live tile QA.

## Tests

`node --test tests/moscow-1000-r1.test.mjs tests/moscow-1000-r2.test.mjs tests/moscow-1000-api.test.mjs`

`python3 tests/smoke_r2_browser.py` (Chromium/Playwright preinstalled environment)

## Privacy and ethical presentation

Only public day-area anchors are hardcoded. Private CRM, contact persons, client lists, exact live user locations and actual visit records are **never** read or synced. OpenStreetMap attribution is visible; publicly hosted OSM tiles are loaded for the current viewport only (no prefetch/download). Attribution and provider policies apply. Before large public traffic, choose a provider with a traffic SLA and compatible terms.

10 days and 1,000 businesses are goals; no personal conversations, pilots, deals or independent media publications are invented.

## R3 — Private editor, verified map markers, inbox, digest

R3 adds a static, access-dependent operator front end at `/moscow-1000/editor/` plus an authenticated Worker backend outside this public directory. Editing and approving content requires a signed Cloudflare Access JWT and configured role. With no Worker, the editor correctly refuses to work. Public results stay `Нет данных` until an approved D1 snapshot is accessible. Approved marker coordinates are rounded to three decimals and never pulled from private CRM.

See `services/moscow-1000-api/README_R3.md` for configuration, manual production gates, confirmed-subscriber newsletter, live video verification, security and staging testing.

## R4 — Media Studio, release calendar and encrypted editorial recovery

R4 adds a Media Studio tab for creator uploads directly to Cloudflare Stream (MP4/WebM <=200 MB), verified encoding status, rights reviews, captions and chapters. A second operator approves documentary video references before the publication engine can release them. All filmed-day materials remain planned until the workflow passes; demo assets from OSMANX STORIES are not represented as documentary footage.

Release Calendar offers ten editable days, evidence/consent checkboxes, independent approval and UTC scheduling; future approved Stream videos stay inaccessible until scheduled publication. Editorial-only backups are AES-GCM encrypted into private R2 and can restore a draft with optimistic versioning without changing public data. Historic public snapshots can be reapproved as new versions after renewed media checks.

This repository carries a dedicated staging-only Wrangler template and a read-only staging probe. **No real infrastructure is connected by this branch.** Do not claim live forms, email, Stream playback or scheduled publication without separate real-account testing. See `services/moscow-1000-api/README_R4.md` and `TECH_REPORT_R4.md`.
