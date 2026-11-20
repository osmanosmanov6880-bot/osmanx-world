# R3 API operator guide — unpublished prototype

R3 builds on the R2 Worker. It adds modules `access.mjs`, `editorial.mjs`, `admin.mjs`, `digest.mjs`, migration `0002_r3_editorial.sql`, and updates `index.mjs`. None of this is published or connected to a Cloudflare account by the source code alone.

## Auth and protection model

The operator webpage lives at `/moscow-1000/editor/` (static assets). It contains **no admin token or confidential data** until the Worker authenticates requests. Protect the static editor path with Cloudflare Access, and separately protect the Worker `/moscow-1000/api/admin/*` route. The Worker **always independently verifies the cryptographic signature**, issuer, audience, dates and email allowlists of the `Cf-Access-Jwt-Assertion` header using the remote Access JWKS. Presence of a header is never considered proof. No password is hard-coded. Browser admin mutations require same-origin `Origin` and JSON `Content-Type`.

Use verified role allowlists `EDITOR_EMAILS`, `APPROVER_EMAILS`, `MODERATOR_EMAILS` and optionally `REQUIRE_TWO_PERSON_REVIEW=true`. Do not assign roles to shared mailboxes. Cloudflare Access `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are required. No role variables means all admin operations fail closed.

## Database and staging

1. Keep the present `main` / VPS unaffected until PRs are reviewed in order R1 → R2 → R3.
2. Create a dedicated **staging D1 database**. Apply migrations `0001_init.sql`, then `0002_r3_editorial.sql` using `wrangler d1 migrations apply` (or the explicit SQL with `wrangler d1 execute`). Keep a verified backup before migrating any existing production database.
3. Prepare a distinct **staging Worker route** on an explicit `staging.osmanx.world` host (`SITE_ORIGIN`), staging Access application, Turnstile site and verified Resend sender. Do not paste secrets into repository or chat. Avoid using the production email list for test sends.
4. Configure `.toml` (copy `wrangler.toml.example`), fill database ID and Access audience; add secrets with `wrangler secret put`. Set `DIGEST_DELIVERY_ENABLED=false` until live opt-in/unsubscribe acceptance tests succeed.
5. Confirm **GET /public-release** returns `status:'unpublished'` with empty arrays. Confirm GET `/admin/session` denies requests without valid Access signature and permitted role.
6. Operator saves a draft via PUT `/admin/editorial` with `expectedRevision`; the approver reviews before POST `/admin/editorial/approve`. The Worker validates data rights flags, strips internal evidence references from public release, and checks HEAD of the actual documentary video if listed. Every publication can be removed with POST `/admin/editorial/unpublish`.
7. Once staged, verify public pins (coordinates rounded to 3 decimals), no private contact information, R1 episodes still planned until a real video is released, and no fake numeric counters.

**Note:** The public API is a cacheable, publication-only endpoint. It reads just `editorial_live`. It never serves `leads`, `subscriptions`, source consent references or precise internal investigation notes.

## Moderator inbox

Only a verified `MODERATOR_EMAILS` actor can GET `/admin/leads`, PATCH `/admin/leads/{id}` and DELETE a lead and review notes. The status field is `new|triaged|replied|closed`; `internal_note` is private. DELETE irreversibly removes the personal record; only a non-identifying operator audit event is retained. Users may request erasure via the published contact channel; operator handles it after verifying the requester's authority.

## Digest sending

1. The editorial release must already include a real, checked and approved video episode.
2. Email recipients come **only** from D1 `subscriptions` with `status='subscribed'` (explicit double opt-in R2). Consent from one category never authorizes unrelated promotional mail.
3. An editor creates a **draft campaign**, a permitted approver queues it. Sending is impossible if `DIGEST_DELIVERY_ENABLED` is not exactly `true`, or required email and unsubscribe configuration is absent.
4. Scheduled/explicit sending uses up to ten deliveries per Worker invocation, atomic DB claims and a stable `Idempotency-Key` per campaign and subscriber (supported by Resend). Unsubscribed addresses are filtered again at send time.
5. Each email includes an HTTPS unsubscribe link. GET only displays a confirmation page; POST verifies an HMAC-signed token and unsubscribes. Preserve `UNSUB_SIGNING_KEY` across deploys so older links remain valid.
6. For a crashed job leaving `processing` rows, **do not auto-resend** until reconciled with Resend delivery history; idempotency keys have a retention window. Failed rows retry at most three attempts; permanently failed rows remain for operator review. A completed queue can contain unsuccessful deliveries; do not infer all recipients received the email.

No mailing service is connected in this PR. Tests use a local SQLite database and mocked Resend responses, not actual mail delivery.

## API routes and security contract

- Public: `GET /health`, `GET /public-release` (safe publication only), `POST /leads`, `POST /subscribe`, `GET/POST /confirm`, `GET/POST /unsubscribe`.
- Operator: `GET /admin/session`, `GET/PUT /admin/editorial`, `POST /admin/editorial/approve`, `POST /admin/editorial/unpublish`.
- Moderator: `GET /admin/leads?status=&offset=`, `PATCH/DELETE /admin/leads/{id}`.
- Mail operator: `GET/POST /admin/campaigns`, `POST /admin/campaigns/{id}/approve|cancel|send-batch`.

All operator endpoints require verified Access JWT and role allowlist; any same-origin protection at the edge is additional defense in depth.

## Tests

```sh
node --check services/moscow-1000-api/{index,access,admin,editorial,digest}.mjs
node --test tests/moscow-1000-*.test.mjs
python3 tests/smoke_r3_browser.py
```

The Python smoke requires the Playwright package and Chromium. It uses **source injection and mocked backend responses** due test sandbox restrictions and does not validate real Cloudflare Access, live OSM tiles, DNS routing or mail delivery. Use `node scripts/check_r3_staging.mjs https://STAGING_HOST` after real staging publication to check the HTTPS routes.
