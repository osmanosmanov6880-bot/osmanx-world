# OSMANX WORLD — Sovereign Edition (public interactive demonstrations)

## Shipped

The static site at `https://osmanx.world/` provides an operational, responsive portal in the cinematic dark/gold art direction with project tiles, sidebar, keyboard search (Ctrl+K), local team roster, local activity log, product documentation and Windows download. Six separate interactive workspaces are served **from the same domain** via `/assets/sovereign/workspace.html?app=...`:

| `app` | Operative browser-only features |
| --- | --- |
| `retail` | anonymous reason survey, aggregates, hypothesis cards, pilot plans, accountable task list |
| `omni` | multi-channel example inbox, replies, change of status |
| `factory` | create/edit locally stored site, sandboxed HTML preview, download working static HTML |
| `cafe` | cart, trial order, guest feedback and order log |
| `senqard` | local projects, task assignment and completion |
| `nebula` | original playable canvas mini-game, local high score |

All screens visibly disclose **DEMO / LOCAL DATA**. The actions have working client state and JSON export, but they are **not connected** to server-side production systems, POS, WhatsApp, 1C, real payments, live project/company data, true NEBULA game infrastructure, or commercial SENQARD users. Do not describe them as production versions or live integrations. No credentials or secrets are embedded. All user text is escaped on output and the exported HTML preview is iframe-sandboxed.

### Verification

Run `node --check assets/sovereign/site.js && node --check assets/sovereign/workspace.js` and `python tests/browser_smoke.py` in a local environment with Chromium/Playwright installed. The isolated browser test injects a localStorage shim because testing in an opaque about:blank origin has no browser storage. A deployed `https://osmanx.world/` has normal first-party localStorage.

GitHub Actions **Deploy osmanx.world** is responsible for syncing the static files to `/var/www/osmanx.world` and verifying SHA-256 parity, public HTTPS marker and workspace routes. Existing binary installers in `assets/downloads` on VPS are explicitly preserved by the deployment exclusion. The desktop download URL points at the existing v1.0.0 Windows installer and an independent SHA-256 manifest. Windows Desktop is itself a local manager, not a client bundling the backend platforms.

### Before any real multi-user deployment

Provision and independently test each backend; verify user access and tenant isolation; configure sessions, HTTPS, rate limits, audit logs, data retention, secrets, backups and rollback; connect provider-approved APIs and actual hardware in a controlled environment; perform security and browser acceptance against the production artifact. No permission to publish unfinished private services or customer data should be inferred from publishing this static front end.
