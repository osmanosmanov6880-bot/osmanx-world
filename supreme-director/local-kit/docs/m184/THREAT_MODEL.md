# Director Studio M184 -- operational threat model (local prototype)

## Assets and protected boundaries

- `runtime/*.sqlite3`: may contain sensitive internal project notes; protect as private local files. Not encrypted at rest, no tenant isolation.
- Session bearer token: generated when `serve` starts, printed to terminal, never written to disk or JavaScript persistent storage. Rotate on restart; no external SSO/MFA.
- Real original M180/M181 source: absent. Never auto-fetch a lookalike repository or deploy an unverified archive.
- Evidence log: local SQLite SHA-256 hash chain; detects ordinary accidental changes and some tampering, but is not a remote signed append-only ledger.

## Attacks tested locally

| Threat | M184 control | Evidence |
|---|---|---|
| Remote listener | binds only 127.0.0.1 | localhost-only construction test |
| DNS rebinding / cross-origin writes | strict Host/Origin/Sec-Fetch-Site and bearer token | HTTP negative tests |
| Browser XSS | textContent for untrusted records, CSP script-src self, no inline scripts | static inspection and browser QA; not external pentest |
| Request flooding | 16 KiB JSON POST cap; limited routes | HTTP oversize test; no exhaustive DoS resistance |
| SQL injection | positional bindings on input-driven SQL | crafted search test |
| Fake independent acceptance | task status constrained to NOT_ACCEPTED, contract UNVERIFIED; no approval API | API/DB negative tests |
| Conflict premature release | state machine excludes RESOLVED; quarantine sticky | negative state transitions |
| Fake Git source mapping | observation team always NULL, verification UNVERIFIED | source observation tests |
| SQLite unexpected edits | constraints, local hash chain and immutable audit row triggers | tamper tests |
| Evidence file escape | no .., bounded size, no symlink, SHA match | path/sha negative tests |
| Concurrent writers | SQLite BEGIN IMMEDIATE transactional appends | 25-threaded-writer test |
| Backup loss | SQLite online backup with synthetic recovery check | local recovery script |

## Critical residual risks

1. **No real authorization between human reviewers.** Anyone holding the local bearer token may add notes and triage provisional conflicts. Displayed actor names are self-asserted, not independently verified identities.
2. **No hardened public-service server.** `http.server` is a stdlib local prototype. Do not expose it via tunneling, reverse proxy, VPN or public network.
3. **No external signed audit provenance.** Host administrator can rewrite SQLite, change code or recompute a hash chain. Production requires independent signed append-only evidence, external keys and owner identity.
4. **No database encryption.** Do not store secrets, customer PII, payment data or sensitive product source in notes or unencrypted evidence folders.
5. **No acceptance of products.** Six source repositories, original 294 dependencies, 28 actual conflicts and nine original contracts remain unverified. The 180 locally stored IDs are a proposed M182 execution plan only.
6. **No real browser localhost networking inside this hosted testing environment.** Browser UI was tested through an explicit Python-to-HTTP bridge. This is documented and must not be relabeled as full physical-device or production network coverage.
7. **No physical mobile hardware or screen-reader audit.** 1440/390/320 browser emulation passed but does not imply WCAG compliance or international-grade usability.

## Minimum hardening before network use

Do NOT deploy this prototype externally as-is. A later product implementation needs managed IAM/RBAC, MFA, tenancy model, HTTPS/TLS/mTLS as applicable, rate limits, hardened ASGI/web server, signed audit/keys, approved data controls, centralized monitoring and independent penetration testing. Release stays NO-GO.
