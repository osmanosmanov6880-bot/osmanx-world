# OSMANX Desktop v1.0.1 — FIVE CORE ONLY

Windows 10/11 x64 desktop hub. Exactly five selected systems: OSMANX WORLD, Retail Intelligence, OSMANX App Factory, OSMANX OmniChat and SENQARD. The catalogue links directly to the public portal and the four verified browser demo workspaces. All backend services remain independent and are NOT bundled with the installer.

Offline portfolio and private local tasks, JSON export/import, no login, no telemetry, no automatic network calls. Only a click opens a verified `osmanx.world` URL in the system browser. Never put production secrets into task notes; local notes are not encrypted.

## Build
```bash
cd desktop
npm install --no-audit --no-fund
npm test
npm run dist:win
```

Release workflow produces `OSMANX-Desktop-Setup-1.0.1.exe` and SHA-256 sums for verification. The Windows installer is **not code-signed** and may trigger SmartScreen. Do not disable Windows security features.

Electron uses a sandboxed renderer, context isolation, CSP `default-src 'none'`, and an allowlist for external destinations. Task import/export has structural limits and does not execute imported content.
