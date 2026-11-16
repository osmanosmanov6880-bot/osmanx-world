# OSMANX WORLD — public Labs and deployment boundary
Verified 16 November 2026. Source-backed catalogue of 25 repositories at /assets/labs/index.html; independently hosted browser experiences: BREAKTHROUGH lesson, THE INTERNET v. HUMANITY cinema preview, and ten ZION-9 worlds. Six Sovereign Edition product demos remain browser-local; do not label them as connected production.

Read-only VPS inventory: https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/43820907227

The existing deploy-osmanx SSH key can update /var/www/osmanx.world, not Nginx, /opt, or systemd. Node.js/npm/Docker not found in deployment PATH; Python3 and active Nginx confirmed. These restrictions prevent safe publication of the original backends on this host without separate privileged infrastructure preparation.

OmniChat real R36 source and migrations ARE available in GitHub branch `release/r36-contabo`; the default main branch contains only docs. This removes the missing-source blocker, but does not authorize production or prove provider API readiness.

To deploy authenticated services, provision a dedicated scoped deployment account through GitHub Actions secrets (NOT in chat), install Node.js 22/Python venv as required, assign isolated systemd services and persistent databases, configure TLS Nginx reverse proxy and subdomain DNS, test backups/restoration, and independently validate the OmniChat R36 branch and its migrations. SENQARD documentation currently explicitly marks its production mode NO-GO. Respect privacy, company isolation, external provider approvals and rollback. Never expose the admin or demo-mode backends to the open internet unprotected.
