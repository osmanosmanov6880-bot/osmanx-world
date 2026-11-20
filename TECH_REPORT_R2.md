# OSMANX WORLD — 1000 DOORS / R2 ENGINEERING REPORT

## Basis

R1: `osmanosmanov6880-bot/osmanx-world`, PR #78, branch `feature/moscow-1000-cinema-r1-20261120`, unmerged draft at start of R2. Existing `main` not changed. Reused R1 public site, planned episode model and staged AI film. New work is a **stacked feature release** depending on R1.

## Five completed source workstreams

1. **Public map**: `moscow-1000/geo.js`, `map.js` plus site markup and CSS. Ten day selectors, 20 approximate geographic orientation anchors, zero invented company records, OSM tile viewer with user-controlled pan/zoom, keyboard support, visible OSM credit, direct OSM links and text-only fallback when tiles cannot load.
2. **Public reviewed analytics**: `publication.js`, `public-r2.js`, independent validator under `editorial/moscow-1000/`. Seven status counters show `Нет данных` until explicit approval; separate reviewed day notes. No private CRM sync, no fabricated successes.
3. **Business/partner/research submissions**: `intake.js`, `services/moscow-1000-api/index.mjs`, D1 schema. Real SQL persistence and Resend notification code; Turnstile checked server-side; honeypot, input limits, exact-origin check and output escaping. Form is disabled until genuine health readiness; mailto fallback clearly explained.
4. **Double opt-in**: pending subscriptions, cryptographically random confirmation and unsubscribe tokens stored only as hashes, server-side token redemption via explicit POST, configured outgoing email. No active mailing automation until service deployed.
5. **Episode integration and QA**: 10 episode pages enhanced with day links and reviewed results, R2 GitHub Actions source QA, 24 Node unit/regression/API tests and Chromium source-injection screenshots on mobile and desktop.

## Verified locally (run in working container)

- `node --check` on R1/R2 JS and API Worker: passed.
- `node --test tests/moscow-1000-r1.test.mjs tests/moscow-1000-r2.test.mjs tests/moscow-1000-api.test.mjs`: 24/24 passed.
- `python3 tests/smoke_r2_browser.py`: 18+ DOM assertions passed at mobile and desktop widths using Chromium source injection; no page JS errors; screenshots captured.
- API tests use in-memory fake D1 + mocked Turnstile/Resend network responses. They do not prove Cloudflare mail delivery, deployed DNS routes or real customer contact persistence.
- No actual production mapping tile load QA was possible in Chromium sandbox; OSM requests were deliberately stubbed for screenshot tests.

## Not finished or not verified

- Cloudflare Worker, D1, Turnstile, Resend and opt-in mailing are **not deployed**; forms remain noninteractive, with mailto fallback, until backend becomes healthy.
- No documentary episodes filmed; existing OSMANX STORIES AI material remains labeled as staged.
- No verified aggregate results; all public statistics remain unavailable, not zero.
- No live tile provider availability verified on physical phone or public HTTPS.
- No separate operator console, authenticated roles, archival video service or newsletter scheduling.
- Production deployment / domain routing **not** changed in this local package.

## Release gate

1. Review stacked R2 PR CI success.
2. Review OSM attribution and exact approximate coordinates; verify public map on physical mobile with network.
3. Configure Cloudflare proxied DNS & Worker route only with explicit approval. Apply D1 migration, configure siteverify and verified sender; perform real test email and double opt-in/unsubscribe.
4. Review privacy text and data-retention policy; operator access to D1 must be restricted.
5. Merge R1 and R2 in controlled order; monitor public HTTPS routes, static and API separately.

## Next five tasks (R3)

1. Real editable editorial administration with authenticated approver.
2. Approved public map markers for consenting participants and actual published events.
3. Authenticated moderator inbox for leads and consent deletion requests.
4. Verified outgoing digest publisher / subscriber unsubscribe in every email.
5. Real staging/mobile E2E and production deploy gate with observability.
