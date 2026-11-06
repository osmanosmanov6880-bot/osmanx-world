# Original 180: local static patch review and changed-source scan

Directly related to original TITAN-X18 and TITAN-X26.

- `review.py` is **read-only**: patch proposal must carry exact previous
  source sha256 for each file, versioned schema, encoded full replacement,
  and distinct declared author/reviewer IDs. It checks isolated path ownership,
  symlink escape, content sizes, Python syntax, secret patterns, and suspicious
  direct dynamic code execution. It emits digests and rule names, not source
  code or secrets. It CANNOT approve PRs, verify reviewers, write changes,
  grant release authorization or run a patch.
- `supplychain.py` scans changed local files offline for high-confidence
  credential patterns and obvious floating dependencies, missing locks/
  malformed manifests, unsafe paths and symlinks. Findings contain paths,
  line numbers, severity and rule names only. It does not query OSV/NVD,
  validate transitive dependency vulnerability/licensing or sign an SBOM.
- GitHub Actions can run `python -m campaign180.supplychain --root . --base HEAD^`
  as a fail-closed, non-production gate for current changes.

Do not interpret declared reviewer identities as verified external identity.
Original independent acceptance remains 0/180. Merge/deploy remains NO-GO.

Rollback: revert only the isolated code/tests and the workflow scan step;
there are no schema migrations or outside writes.
