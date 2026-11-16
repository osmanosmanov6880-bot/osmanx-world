# OSMANX WORLD — Five Core Platforms (Sovereign Edition)

Public scope is **only five systems**:
1. OSMANX WORLD — the public headquarters and local portal.
2. Retail Intelligence — browser demo of questions, hypotheses, pilots, and tasks.
3. OSMANX App Factory — browser demo of HTML site creation and export.
4. OSMANX OmniChat — browser demo of incoming messages and operator queues.
5. SENQARD — browser demo of projects and tasks.

Only four workspaces exist because WORLD is the portal itself:
`/assets/sovereign/workspace.html?app=retail|factory|omni|senqard`.
Unsupported legacy app selectors redirect to the selected core product list.

Other repositories are **not included** in the portal: no OSGARD/NEBULA, hospitality demo, or the former 25-repository Labs directory. Their original GitHub repositories are not changed. Files previously added under `assets/labs/` are removed from this public deployment using GitHub + rsync --delete. The existing Windows installer is excluded from rsync deletion.

## Product deployment truth

This deployment serves static HTML/CSS/JavaScript with browser-local state. It does not run original Retail, App Factory, OmniChat or SENQARD production backends. Do not show real client data or pretend that chats, orders, integrations, multi-user accounts or customer revenue are connected.

- Retail Intelligence source: `osmanx-retail-intelligence` main, FastAPI and persistent DB.
- App Factory source: `osmanx-app-factory` main, Node.js >=22.16.
- OmniChat real R36 backend/frontend sources are in `osmanx-omnichat` branch `release/r36-contabo` (NOT main), requiring isolated PostgreSQL and provider setup.
- SENQARD production rollout remains subject to its own independent production readiness gates.

Read-only VPS inventory: https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/43820907227
Existing `deploy-osmanx` SSH account can only manage the static site directory. Node/npm/Docker unavailable in that PATH, and account cannot alter Nginx or systemd units. Deploying real services requires scoped infrastructure provisioning, reverse proxy/TLS, tenant isolation, secrets, backups and tested rollback.

## Acceptance

- GitHub deployment verifies SSH, SHA-256, public HTTPS and old Lab asset removal.
- Browser workflow tests real Chromium at 1440px/390px and functional interactions.
- Never paste passwords or private SSH keys into ChatGPT; provision a restricted key in GitHub Secrets.
