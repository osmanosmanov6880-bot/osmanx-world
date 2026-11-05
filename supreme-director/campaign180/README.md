# OSGARD 180 - original campaign gate (Wave 0)

This code is the first direct implementation pass against the **original**
October 17, 2026 180-task master (not a synthetic M207 roadmap).

Implemented components:

1. Source registry with exact original SHA-256 and 6x30/60-90-30 checks;
   fail-closed upstream provenance; read-only Git file/hash/dependency inventory.
2. Per-task audit: 180 original IDs, related local evidence without fake acceptance,
   four SkillCred scope holds and four Noor missing-source holds.
3. CODEOWNERS plus review gate blocking protected master edits, unapproved six-team
   product sources, cross-team changes and tracked sensitive-file paths.
4. Versioned TaskEnvelope/ResultEnvelope validator with identity/tenant/scope/TTL
   controls, bounded safe JSON, result digest binding and SQLite replay guard.

**Not done:** independent upstream ownership approvals; real six-product merges;
lockfile/signature provenance; DevSwarm execution integration; independent
180-task review; production authorization. All original tasks remain 0/180
independently accepted until complete evidence is supplied.

Usage (from repo root with Python >=3.11):

    export PYTHONPATH="$PWD/supreme-director/campaign180"
    python3 -m campaign180 audit --root . --output ./out-180
    python3 -m campaign180 inventory --root . --output ./out-180/inventory.json
    python3 -m campaign180 gate --root . --change supreme-director/campaign180/README.md
    python3 -m unittest discover -s supreme-director/campaign180/tests -v

These operations are entirely local, never contact upstream repositories,
never execute user-supplied tasks, and do not perform payments/deployments.
