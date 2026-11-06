# Wave 6 — actual local Chromium browser acceptance

Wave 6 adds a standalone end-to-end Chromium test with **no npm package
installation**. It uses Node 22's built-in WebSocket and Chrome DevTools
Protocol against a temporary SQLite project and loopback WSGI server.

The test verifies:
1. Token-only local login and server-provided owner role
2. Responsive dashboard and a desktop screenshot
3. Add a section, edit its heading and verify a revisioned preview
4. Create a customer in the visual editor and verify it in SQLite via API
5. Create and run a manual workflow via the console
6. Create a `record.created` workflow and verify its *automatic* action
7. Resize Chromium to 390 px, detect horizontal overflow and capture mobile UI
8. Fail on browser runtime exceptions

Screenshots are uploaded as a short-retention GitHub Actions artifact.
The flow runs only on a disposable localhost instance, not the public
Internet, and creates no production deployment, webhook or paid action.
A successful test verifies the browser interactions tested, **not**
full independent product acceptance or production security.

Workflow: `.github/workflows/supreme-director-campaign180-browser.yml`.
The test requires Chrome or Chromium preinstalled on the runner; it fails
closed if none is available. To reproduce manually:
```bash
node --version # 22 or newer
node --check supreme-director/campaign180/assets/console.js
node supreme-director/campaign180/tests/browser-console.mjs
```
