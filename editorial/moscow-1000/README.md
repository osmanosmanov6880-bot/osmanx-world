# Manual publication gate

No CRM import is wired. Public `moscow-1000/publication.js` is **unpublished** by default.

Before publishing real aggregate results:

1. Obtain explicit publication approval. Work only with aggregated, non-identifying metrics; remove contacts, phones, email, exact live location and confidential client notes.
2. Maintain a methodological note describing the observation window, sample selection, missing data and limits. Never imply representative samples without evidence.
3. Write **reviewed** data into a separate JSON file based on `publication-draft.example.json`. Set status to `published`, `reviewedAt` to an actual UTC ISO timestamp, supply the real reviewer and method, and enter only source-grounded counters.
4. For each summary day include the exact day 1–10, a safe summary and a safe lesson, and set `approvedForWeb=true` only with authorization.
5. Run `node editorial/moscow-1000/validate-publication.mjs reviewed.json moscow-1000/publication.js --confirm-publication` from repo root.
6. Review the generated diff in a PR. No auto-publication, no automatic access to private R3 CRM, no external webhook.
7. Update or withdraw misleading results by an explicit reviewed commit. Keep approval documentation in a private restricted system, NOT under `moscow-1000/` which is published publicly.

The validator is a safety backstop, not independent fact-checking. It rejects extra fields, malformed metrics, direct emails/phone-like values in narrative fields and unapproved day notes. Human review is still mandatory.
