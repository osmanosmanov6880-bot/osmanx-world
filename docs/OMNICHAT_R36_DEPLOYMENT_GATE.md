# OmniChat R36 — real-source integration and deployment boundary

This is one of exactly five OSMANX WORLD products.

## What is available
- Existing full source ZIP v1.2 from the user: 173 files were verified against RELEASE_MANIFEST_SHA256.txt, no .env secrets or database were bundled.
- GitHub branch release/r36-contabo is newer; pin f3d4e430d879cec5d1ad9fa96ce5e6e5e0e33715 as the active reference.
- Full R36 source and SHA256 published via osmanx.world/assets/downloads/OSMANX-OmniChat-R36-Full-Source.zip by GitHub Actions #43830599600.
- Browser-local OmniChat test inbox works at /assets/sovereign/workspace.html?app=omni.
- Canonical product page with actual API-readiness probe: /assets/omnichat/index.html. Its live login link is deliberately hidden until JSON status=ready,database=ok is received from https://chat.osmanx.world/api/health/ready. CORS must explicitly permit the osmanx.world origin once live.

## Current deployment blockers
- The active osmanx.world deploy identity can write static /var/www/osmanx.world but cannot install Docker/Node, configure Nginx or systemd, or administer PostgreSQL.
- R36 CI run https://github.com/osmanosmanov6880-bot/osmanx-omnichat/actions/runs/42322292137 is not fully passing. A browser test hardcodes /mnt/data; a schema restore command misses PYTHONPATH=backend; and a PostgreSQL concurrency assertion reported two possibly-sent outcomes where one was expected. Last issue is a real release blocker, not cosmetic.
- No official provider credentials/permissions and test acceptance are confirmed for WhatsApp/Instagram/Avito and other channels.
- No secure public backend, database, independent restore exercise, TLS/secure cookies or incident alerts have been certified on chat.osmanx.world.

## Required before real launch
1. Dedicated least-privilege service deployment identity with infrastructure permissions, not root passwords in chat.
2. DNS for chat.osmanx.world and correctly scoped HTTPS reverse proxy. Keep existing osmanx.world and senqard.world configurations untouched.
3. Isolated database and encrypted keys, migration/backup+restore, supported React frontend and worker health supervision.
4. Fix R36 CI failures and run independent multi-tenant/parallel PostgreSQL tests, then validate official provider connections from real test accounts.
5. Enable production login only after API smoke, role-isolation, auditing, monitoring and rollback are accepted.

Never treat local browser message simulation as proof of actual provider delivery.
