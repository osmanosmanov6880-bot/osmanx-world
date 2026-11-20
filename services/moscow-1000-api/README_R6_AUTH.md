# R6 — Google login and the private command center

This release implements a real Google OpenID Connect authorization-code flow and a D1-backed private command center. It contains no demo accounts, browser-only login bypass, sample CRM records or fabricated public statistics. Google authentication is **not activated by source code alone**: the owner's Google OAuth client, server secrets and deployed HTTPS callback must be configured.

## Required deployment configuration

Apply migrations `0001` through `0005_r6_command_center.sql` to the intended D1 database. Keep the existing Worker route `/moscow-1000/api/*` and the site's HTTPS origin. Set these Worker environment values through secret/configuration management:

| Variable | Purpose |
| --- | --- |
| `SITE_ORIGIN` | Exact deployed HTTPS origin, e.g. `https://osmanx.world`. The existing Worker host allowlist remains in force. |
| `GOOGLE_CLIENT_ID` | OAuth **Web application** client ID ending in `.apps.googleusercontent.com`. |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret; server secret only. |
| `AUTH_SESSION_SECRET` | Independent cryptographically random signing secret, at least 32 characters; server secret only. |
| `ADMIN_GOOGLE_EMAILS` | Explicit comma-separated administrator email allowlist. Empty means Google login is disabled. No email is hardcoded or inferred from a GitHub profile. |
| `REQUIRE_TWO_PERSON_REVIEW` | Preserved existing independent-approval requirement. When `true`, the last private-data editor cannot publish its aggregates. |

Register exactly this authorized Google redirect URI, substituting the selected origin:

`https://osmanx.world/moscow-1000/api/auth/google/callback`

The return destination is fixed to `/moscow-1000/admin/`; untrusted redirect parameters are not used. If Cloudflare Access currently protects the entire site, configure the public frontend and the Google authorization/callback endpoints to be reachable as intended. Keep private API authorization in the Worker. Do not disable the server's role checks. Existing Cloudflare Access operators continue to work.

The Google allowlist grants these explicitly selected administrators the editor, approver and moderator roles. This email-based administrator setup accepts Gmail accounts or verified Google Workspace accounts with a signed `hd` claim. A Google account created using an external, non-Workspace mailbox is rejected because Google cannot establish its current email ownership from `email_verified` alone. The two-person publication rule still prevents self-approval when enabled. Use separate accounts or retain the existing Cloudflare Access role allowlists for separation of duties.

## Authentication behavior

- `GET /auth/config` returns only readiness booleans. Missing secrets, absent migration or missing database gives `googleEnabled:false`.
- `GET /auth/google/start` creates a ten-minute, one-use D1 transaction, browser-bound state, nonce and S256 PKCE challenge. It requests only `openid email`.
- The callback redeems the code server-side and checks the Google RS256 signature using Google's public JWKS, issuer, audience/authorized party, expiration, issued-at time, nonce, verified email and explicit admin allowlist.
- A successful login creates a two-hour revocable D1 session and a signed `__Host-` cookie with Secure, HttpOnly and SameSite=Lax. Neither Google tokens nor OAuth secrets are returned to frontend JavaScript or written to localStorage.
- `GET /auth/session` reports the server-verified actor. `POST /auth/logout` revokes the D1 session and expires cookies. Changing the allowlist takes effect on the next request. Rotating `AUTH_SESSION_SECRET` invalidates existing cookies.
- Mutations require same-origin `Origin` and JSON content type. Authorization state is atomically consumed before code exchange, so replayed and concurrent callbacks cannot create extra sessions.
- Expired flows/sessions are cleaned during login and the existing daily cron. Google logout does not log an independent Cloudflare Access identity out of its separate provider.

These source-level checks are covered by cryptographic protocol tests with real RSA signatures and temporary SQLite databases. They are not evidence of successful sign-in against a configured live Google account. Live acceptance must include the exact deployed callback, allowed/disallowed accounts, browser cookies, logout and session revocation.

## Command center API

All paths below follow `/moscow-1000/api/command`. Private reads require a server-verified operator. Changes require the editor role; publication requires approver. Request JSON is bounded to 8 KiB and SQL values use parameters.

| Endpoint | Behavior |
| --- | --- |
| `GET /contacts?day=1&offset=0` | Private records, 25 per page, optional day filter. |
| `POST /contacts` | Create `{day,name,category,person,channel,outcome,problem,nextStep}`. `name` is required. Outcomes: `visited`, `dialogue`, `interest`, `refusal`, `meeting`, `pilot`, `contract`. |
| `PATCH /contacts/:id` | Replace editable fields plus `expectedRevision`; stale changes return 409. |
| `DELETE /contacts/:id` | JSON `{expectedRevision}`; stale deletion returns 409. |
| `GET /expenses?day=1&offset=0` | Private expense list with pagination. |
| `POST /expenses` | `{day,amountRub,category,note}`; stored as integer kopecks, max two decimals. |
| `DELETE /expenses/:id` | JSON `{}`. |
| `GET /quests` | Private completion state. |
| `PUT /quests` | `{day,questId,completed}` with IDs `d1-q1` through `d10-q5`. |
| `POST /publish` | `{confirm:true}` explicitly publishes a consistent aggregate snapshot of **all days**. |
| `POST /unpublish` | `{}` withdraws the public snapshot immediately. |
| `GET /public` | Public allowlisted aggregate snapshot; no contact names, channels, business names, notes or operator identities. |

Public metrics are initially `null`, not fictional zero results. A deliberate first publication may produce genuine zero totals. Counts describe stored records: researched/visits count CRM rows; dialogues include the dialogue/interest/meeting/pilot/contract stages; contacts count records with a named person; meetings and decisionMeetings count meeting/pilot/contract; proposals count interest or later; pilots include pilot/contract. These are operational counts, not independently verified research evidence. Expense totals sum integer kopecks. Quest XP uses `[150,200,100,100,150]` for five daily tasks. No task awards XP twice.

Private edits never alter a public snapshot implicitly. Aggregate publication reads a single D1 batch and rejects changes if private data or the public version changed before committing. Publication and its audit are committed in one guarded transaction. Withdrawal creates a tombstone even before the first publication and always advances the publication generation, preventing an already-running stale publish from reversing withdrawal. Generation numbers may therefore skip in the publicly visible version history. Reads reconstruct a public field allowlist even if the stored JSON acquires additional keys. Invalid snapshots fail closed. Deleting a private contact does not retroactively change an approved historic aggregate; republish or withdraw as appropriate. The private problem note accepts normal LF/CR line breaks; other control characters remain rejected.

## Verification

Run `node --test tests/moscow-1000-r6-auth.test.mjs` from the repository root. Tests use synthetic identities only and contact no Google account, send no messages, and deploy no resources.

Primary protocol references:

- https://developers.google.com/identity/openid-connect/openid-connect
- https://developers.google.com/identity/openid-connect/reference
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
