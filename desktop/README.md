# OSMANX Desktop v1.0.0

Windows 10/11 x64 desktop hub. Offline catalog, local project tasks with JSON export/import, safe links to public GitHub sources and osmanx.world. It is **not** a packaged instance of Retail Intelligence, OmniChat, SENQARD, App Factory or NEBULA. Those products have independent backend/infra requirements. No login, telemetry or automatic network calls are implemented.

## Build

```bash
cd desktop
npm install --no-audit --no-fund
npm test
npm run dist:win
```

Release workflow runs on Windows and publishes `OSMANX-Desktop-Setup-1.0.0.exe` with SHA-256 checksums. An unsigned installer may trigger Windows SmartScreen. Download only from the verified HTTPS domain or GitHub release, confirm SHA-256 and check publisher information. Never disable operating system security controls globally.

## Trust boundary

Electron uses context isolation, sandboxed renderer, no Node integration, a restrictive Content Security Policy and allowlisted external destinations. JSON import has a strict size and field limit and never executes imported content. Export is user-initiated. Tasks persist in the application's local user profile (un-encrypted); do not store passwords or API tokens in notes.

The public website is a static product *catalog*, not a live deployment of the platforms listed.
