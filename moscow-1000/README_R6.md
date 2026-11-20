# OSMANX MOSCOW 1000 — R6

R6 replaces the viewer entry page with a mobile-first command interface based on the supplied visual reference. It keeps the previous documentary landing page, episode pages, player, editorial workflow and Worker services available.

## Source layout

| Path | Purpose |
| --- | --- |
| `/moscow-1000/` | Viewer interface: headquarters, map, analytics, journal and quests. |
| `command.css`, `command.js` | Responsive visual system, tab navigation, dialogs, public snapshot rendering and public JSON export. |
| `command-data.js` | Shared 50-quest catalogue and public-data allowlist. Five tasks per day; 700 XP per day. |
| `command-map.js`, `command-map.css` | Real OpenStreetMap tiles, public geographical anchors, zoom, pan, day selection and map failure state. |
| `reference/moscow-skyline.png` | Exact 636 × 174 crop of the supplied artwork, source rectangle (1036, 0, 1672, 174). No synthesis or retouching; only the decorative skyline is reused. |
| `/moscow-1000/admin/` | Private command interface: contacts, expenses, quest state and aggregate publication. |
| `/moscow-1000/serial/` | Relocated R1–R5 documentary landing, archive player, participation forms and original map. |
| `/moscow-1000/episodes/01/` … `/10/` | Existing episode pages. |
| `/moscow-1000/editor/` | Existing advanced editorial and media tools. |
| `../services/moscow-1000-api/auth-google.mjs` | Server-side Google OpenID Connect and revocable sessions. |
| `../services/moscow-1000-api/command-center.mjs` | D1-backed private records and explicitly approved public aggregates. |

## Public and private data

The viewer fetches only `/moscow-1000/api/command/public` and the existing `/moscow-1000/api/public-release`. Private contact names, communication channels and notes are not requested by the public interface. Unpublished metrics remain dashes; the sample numbers shown in the design reference are not presented as actual expedition results. A deliberately published empty dataset can legitimately contain zero totals.

Viewers can switch days and screens, inspect geographical anchors, read the plan and approved results, open episode pages and export an approved public summary. They cannot mark quests complete or edit operational records.

The administrator interface starts locked. It uses server-confirmed authentication, saves records through the private API and requires explicit confirmation before publishing the aggregate snapshot for all days. Contacts use optimistic revisions to reject stale edits and deletions. No browser-only login, demo account or local token storage is included.

## Running and checking

Serve this repository root over HTTP(S), retaining the `/moscow-1000/` path. The frontend is buildless HTML, CSS and JavaScript. Opening a page directly through `file://` is not an acceptance test for API behavior. A static preview without the Worker displays unpublished public metrics and a locked administrator screen.

From the repository root, with Node 22:

```sh
node --test tests/moscow-1000-*.test.mjs
```

`tests/moscow-1000-r6-ui.test.mjs` covers quest identities and XP, public snapshot validation, private-field stripping, map projection round trips, screen/resource linkage, locked admin defaults and text escaping. `tests/moscow-1000-r6-auth.test.mjs` tests authentication and private API behavior using real cryptographic signatures and temporary SQLite fixtures. Existing R1/R2 HTML checks now inspect `/serial/` where their archive player, original map and forms live. Their behavioral assertions are retained; R3–R5 backend regression tests remain in place.

The R6 GitHub Actions workflow runs syntax checks and the complete Node suite. These checks do not constitute live Google-account or physical-phone acceptance. Actual application screenshots must be captured from the running frontend; the supplied composite reference is not a screenshot of the implemented application.

## Deployment limits

The source includes a real Google login implementation, but credentials and deployment are still required. Configure the exact HTTPS origin, Google web OAuth client, callback, secret, explicit administrator allowlist and D1 migrations. Follow [the authentication deployment guide](../services/moscow-1000-api/README_R6_AUTH.md). Do not insert secrets into frontend files.

The map depends on reachable OpenStreetMap tiles. Its routes connect public area anchors schematically; they are not verified pedestrian directions. The interface does not request the viewer's location or publish the author's private position. If tiles fail, the app displays an error and keeps the list of geographical anchors available.

The interface adapts the reference to usable browser screens, without simulated phone hardware or generated photographs. No exact pixel-identity or live authentication claim is made solely from source tests.
