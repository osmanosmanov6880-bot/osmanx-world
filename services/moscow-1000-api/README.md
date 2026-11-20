# OSMANX Moscow 1000 — private intake Worker (R2)

This service is **not deployed** by the static website workflow. No valid D1 ID, Turnstile keys or Resend secrets are included. The public forms remain clearly disabled until a real same-origin Worker health check succeeds.

## Explicit deployment prerequisites

1. In Cloudflare ensure osmanx.world is using **proxied** DNS and HTTPS; route on existing origin only intercepts `/moscow-1000/api/*`.
2. Create D1 database, copy `wrangler.toml.example` to untracked `wrangler.toml`, configure real database ID and sitekey. `npx wrangler d1 migrations apply osmanx-moscow-1000 --remote` with migration copied to Wrangler project's expected `migrations` dir.
3. Create a Turnstile widget restricted to hostname `osmanx.world`. Set secret via `npx wrangler secret put TURNSTILE_SECRET`.
4. Verify sending domain in Resend, set `EMAIL_FROM` (approved sender), set `NOTIFY_EMAIL`, then `npx wrangler secret put RESEND_API_KEY`.
5. Review privacy notice, legal basis and retention. Leads are automatically purged after 180 days; unconfirmed/unsubscribed subscriptions after 30 days. Verified subscribers remain until opt-out, which should also be supported through a privacy contact.
6. Deploy Worker in separate change window; confirm `GET /moscow-1000/api/health` returns `leadsEnabled:true` and `subscriptionEnabled:true`. Verify real email delivery (both notification and double opt-in), D1 state, unsubscribe and full form flow; monitor abuse.
7. Keep private lead data only in D1; restrict Cloudflare dashboard/Wrangler access. There is no public admin API. Create a separate authenticated operator UI in a later release.

The form returns `stored_notification_pending` if D1 saved the request but the Resend notification could not be sent. Operators should check D1 when email delivery fails; don't equate a submitted form with a paid client.

Test with `node --test tests/moscow-1000-api.test.mjs` from repository root. Production service is fail-closed when any required binding is missing.
