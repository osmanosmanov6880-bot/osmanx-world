#!/usr/bin/env bash
# Verify content integrity of a R6 release from CI before ANY operator deploy.
# SHA256SUMS detects corruption; it is NOT a cryptographic publisher signature.
set -euo pipefail
umask 077
if (( $# != 1 )); then echo "Usage: bash ops/verify-release.sh RELEASE.tar.gz" >&2; exit 2; fi
archive="$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
name="$(basename "$archive")"
[[ "$name" =~ ^osmanx-industry-[a-f0-9]{12}\.tar\.gz$ ]] || {
  echo "Unknown release filename" >&2; exit 2;
}
test -f "$archive" && test -f "$archive.sha256" || {
  echo "Missing archive or checksum" >&2; exit 2;
}
(
  cd "$(dirname "$archive")"
  sha256sum -c -- "$name.sha256" >/dev/null
)
test "$(stat -c %s "$archive")" -le 10485760 || {
  echo "Archive exceeds size limit" >&2; exit 3;
}
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP TERM INT
tar -tzf "$archive" > "$tmp/members.txt"
# Reject duplicate paths and special link/device types BEFORE extraction.
if LC_ALL=C sort "$tmp/members.txt" | uniq -d | grep -q .; then
  echo "Duplicate archive path" >&2;exit 3
fi
if tar -tzvf "$archive" | cut -c1 | grep -Eq '^[^d-]'; then
  echo "Links and special tar entries are not permitted" >&2;exit 3
fi
while IFS= read -r path; do
  [[ "$path" == "industry-api" || "$path" == industry-api/* ]] || {
    echo "Archive has path outside industry-api/" >&2; exit 3;
  }
  [[ "$path" != /* && "$path" != *"/../"* && "$path" != *"/./"* && "$path" != *"/.." &&
     "$path" != *"//"* ]] || {
    echo "Unsafe archive path" >&2; exit 3;
  }
done < "$tmp/members.txt"
tar -xzf "$archive" -C "$tmp" --no-same-owner --no-same-permissions
root="$tmp/industry-api"
test -d "$root" && test -f "$root/SHA256SUMS"
test -f "$root/Dockerfile" && test -f "$root/compose.yml"
test -f "$root/shared/pilot-model.js" && test -f "$root/src/guest.mjs"
test -f "$root/ops/compose.staging.yml" && test -f "$root/ops/stage-launch.sh"
test -f "$root/ops/r10-operator-gate.sh" && test -f "$root/scripts/r10-stage-gate.mjs"
test -f "$root/ops/compose.r14.yml" && test -f "$root/ops/r14-canary.sh"
test -f "$root/scripts/r14-monitor.mjs" && test -f "$root/scripts/r14-admission.mjs"
test -f "$root/scripts/r14-incident.mjs"
test -f "$root/RELEASE.json"
revision="${name#osmanx-industry-}"
revision="${revision%.tar.gz}"
grep -Fq "\"commit\":\"$revision\"" "$root/RELEASE.json" || {
  echo "Release revision does not match archive" >&2;exit 3;
}
grep -Fq '"schema":"osmanx.industry.r14.release.v1"' "$root/RELEASE.json" || {
  echo "R10 release schema missing" >&2;exit 3;
}
grep -Fq '"migration":"011_guest_pilot_safety.sql"' "$root/RELEASE.json" || {
  echo "R9 database migration missing" >&2;exit 3;
}
grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
  echo "Release lacks fail-closed write gate" >&2;exit 3;
}
# R18 extensions are required only in R18 release bundles; legacy R14
# archives remain verifiable, but they are NOT R18 production acceptance.
if grep -Fq '"externalAnchorRequiredForR18":true' "$root/RELEASE.json"; then
  if grep -Fq '"singlePilotScopeSupportedR19":true' "$root/RELEASE.json"; then
    (grep -Fq '"latestMigration":"014_guest_single_pilot_rollout.sql"' "$root/RELEASE.json" ||
      grep -Fq '"r19Migration":"014_guest_single_pilot_rollout.sql"' "$root/RELEASE.json") || {
      echo "Missing R19 schema declaration" >&2;exit 3;
    }
  else
    grep -Fq '"latestMigration":"013_guest_external_anchor_fence.sql"' "$root/RELEASE.json" || {
      echo "Missing R18 schema declaration" >&2;exit 3;
    }
  fi
  full_sha="$(sed -n 's/.*"fullCommit":"\([a-f0-9]\{40\}\)".*/\1/p' "$root/RELEASE.json")"
  [[ "$full_sha" =~ ^[a-f0-9]{40}$ ]] && test "$(printf '%.12s' "$full_sha")" = "$revision" || {
    echo "R18 full commit does not match source release" >&2;exit 3;
  }
  for entry in migrations/013_guest_external_anchor_fence.sql \
    src/guest-r18-anchor.mjs src/guest-r18-fence.mjs src/guest-r18-proof.mjs \
    scripts/r18-dr-rehearsal.mjs scripts/r18-proof.mjs \
    scripts/r18-anchor-signer.mjs scripts/r18-release-gate.mjs; do
    test -f "$root/$entry" || {
      echo "R18 release missing $entry" >&2;exit 3;
    }
  done
fi
# R19 is an optional, explicitly signed one-pilot permission. Release tools
# assert the complete code exists but NEVER enable it automatically.
if grep -Fq '"singlePilotScopeSupportedR19":true' "$root/RELEASE.json"; then
  for entry in migrations/014_guest_single_pilot_rollout.sql \
    src/guest-r19-scope.mjs src/guest-r19-usage.mjs \
    scripts/r19-operator.mjs scripts/r19-first-client-rehearsal.mjs; do
    test -f "$root/$entry" || {
      echo "R19 release missing $entry" >&2;exit 3;
    }
  done
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R19 must ship with collection disabled" >&2;exit 3;
  }
fi
# R20 source delivery is non-activating. Require all read-only operator
# modules and the explicitly disabled-by-default collection policy.
if grep -Fq '"releaseReviewSupportedR20":true' "$root/RELEASE.json"; then
  (grep -Fq '"latestMigration":"014_guest_single_pilot_rollout.sql"' "$root/RELEASE.json" ||
      grep -Fq '"r19Migration":"014_guest_single_pilot_rollout.sql"' "$root/RELEASE.json") || {
    echo "R20 release requires the R19 schema" >&2;exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R20 must not activate writes" >&2;exit 3;
  }
  for f in scripts/r20-release-chain.mjs scripts/r20-change-ticket.mjs \
    scripts/r20-restore-crosscheck.mjs src/guest-r20-inspection.mjs; do
    test -f "$root/$f" || {
      echo "Missing R20 operator release module $f" >&2;exit 3;
    }
  done
fi
# R21 operator gates are read-only. Retain all R14-R20 modules and make
# any packaged R21 claim dependent on the full immutable source graph.
if grep -Fq '"hostPostureSupportedR21":true' "$root/RELEASE.json"; then
  grep -Fq '"releaseReviewSupportedR20":true' "$root/RELEASE.json" || {
    echo "R21 package missing R20 provenance" >&2;exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R21 package must keep production collection disabled" >&2;exit 3;
  }
  for f in src/guest-r21-db-audit.mjs \
    scripts/r21-release-chain.mjs scripts/r21-host-posture.mjs \
    scripts/r21-db-audit.mjs scripts/r21-evidence-bundle.mjs \
    scripts/r21-assemble.mjs; do
    test -f "$root/$f" || {
      echo "R21 required operator module missing $f" >&2;exit 3;
    }
  done
fi
# R22 contains only non-activating release, signed host and two-copy DR
# evidence modules. Even a verified artifact is NOT a production permission.
if grep -Fq '"independentReadinessSupportedR22":true' "$root/RELEASE.json"; then
  grep -Fq '"hostPostureSupportedR21":true' "$root/RELEASE.json" || {
    echo "R22 release requires R21 source provenance" >&2;exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R22 must ship with data collection disabled" >&2;exit 3;
  }
  for f in scripts/r22-release-chain.mjs \
    scripts/r22-host-witness.mjs scripts/r22-dr-quorum.mjs \
    scripts/r22-preflight-review.mjs; do
    test -f "$root/$f" || {
      echo "R22 source release missing $f" >&2;exit 3;
    }
  done
fi
# R23 is review-only. Require full R22 ancestry, no guest write defaults
# and all five operator components in every reproducible release.
if grep -Fq '"manualStagingSupportedR23":true' "$root/RELEASE.json"; then
  grep -Fq '"independentReadinessSupportedR22":true' "$root/RELEASE.json" || {
    echo "R23 depends on R22 immutable release content" >&2;exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R23 cannot activate live guest writes" >&2;exit 3;
  }
  for f in scripts/r23-merge-plan.mjs \
    scripts/r23-http-canary.mjs scripts/r23-tenant-isolation.mjs \
    scripts/r23-operator-handoff.mjs src/guest-r23-panel.mjs; do
    test -f "$root/$f" || {
      echo "R23 operator component missing $f" >&2;exit 3;
    }
  done
fi
# R24 aggregate-only intelligence is non-activating. Require the full
# quality/statistics/economics/playbook/report source and disabled writes.
if grep -Fq '"decisionIntelligenceSupportedR24":true' "$root/RELEASE.json"; then
  grep -Fq '"manualStagingSupportedR23":true' "$root/RELEASE.json" || {
    echo "R24 requires verified R23 ancestry" >&2;exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R24 must never activate guest collection" >&2;exit 3;
  }
  for f in src/guest-r24-quality.mjs \
    src/guest-r24-statistics.mjs src/guest-r24-economics.mjs \
    src/guest-r24-playbook.mjs src/guest-r24-brief.mjs; do
    test -f "$root/$f" || {
      echo "R24 required intelligence module missing $f" >&2;exit 3;
    }
  done
fi
# R25 category collection is disabled by default and uses the R19 budget
# when independently enabled on an approved pilot. Never ship a live key.
if grep -Fq '"operationalHypothesesSupportedR25":true' "$root/RELEASE.json"; then
  grep -Fq '"decisionIntelligenceSupportedR24":true' "$root/RELEASE.json" || {
    echo "R25 requires R24 source provenance" >&2;exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R25 cannot activate live guest writes" >&2;exit 3;
  }
  for f in migrations/015_guest_r25_operational_tallies.sql \
    src/guest-r25-signals.mjs src/guest-r25-hypotheses.mjs \
    src/guest-r25-experiment.mjs src/guest-r25-brief.mjs; do
    test -f "$root/$f" || {
      echo "R25 operational module missing $f" >&2;exit 3;
    }
  done
fi
# R26 metadata never authorizes production; require verified migration and
# source-reliability components, while retaining old R19 schema proof.
if grep -Fq '"sourceReliabilitySupportedR26":true' "$root/RELEASE.json"; then
  grep -Fq '"operationalHypothesesSupportedR25":true' "$root/RELEASE.json" || {
    echo "R26 requires anonymous R25 evidence" >&2;exit 3;
  }
  grep -Fq '"latestMigration":"016_guest_r26_source_reviews.sql"' "$root/RELEASE.json" || {
    echo "R26 migration must be current" >&2;exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R26 cannot enable Guest production collection" >&2;exit 3;
  }
  for f in migrations/016_guest_r26_source_reviews.sql \
    src/guest-r26-bias.mjs src/guest-r26-review.mjs \
    src/guest-r26-decision.mjs src/guest-r26-brief.mjs; do
    test -f "$root/$f" || {
      echo "R26 component missing $f" >&2;exit 3;
    }
  done
fi
# R27 is a read-only rehearsal and protected human handoff.
# It adds zero new production writes, migrations or deployment actions.
if grep -Fq '"firstClientRehearsalSupportedR27":true' "$root/RELEASE.json"; then
  grep -Fq '"sourceReliabilitySupportedR26":true' "$root/RELEASE.json" || {
    echo "R27 must include source-verification ancestry R26" >&2;exit 3;
  }
  grep -Fq '"latestMigration":"016_guest_r26_source_reviews.sql"' "$root/RELEASE.json" || {
    echo "R27 requires migration 016 in its ancestry" >&2;exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R27 cannot enable real guest collection" >&2;exit 3;
  }
  for f in src/guest-r27-decision-audit.mjs \
    src/guest-r27-rehearsal.mjs src/guest-r27-handoff.mjs \
    scripts/r27-release-plan.mjs; do
    test -f "$root/$f" || {
      echo "R27 mandatory module missing $f" >&2;exit 3;
    }
  done
fi
# R28 is a manual-review source package only. No public deployment
# or customer collection can be enabled by the release manifest.
if grep -Fq '"independentReleaseReviewSupportedR28":true' "$root/RELEASE.json"; then
  grep -Fq '"firstClientRehearsalSupportedR27":true' "$root/RELEASE.json" || {
    echo "R28 missing verified R27 source" >&2;exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R28 cannot activate production collection" >&2;exit 3;
  }
  for f in src/guest-r28-attestations.mjs src/guest-r28-stage-gate.mjs \
    src/guest-r28-operator-packet.mjs scripts/r28-release-plan.mjs \
    scripts/r28-verify-evidence.mjs; do
    test -f "$root/$f" || {
      echo "R28 mandatory offline module missing $f" >&2;exit 3;
    }
  done
fi
# R29 staging and merge review is read-only and cannot enable real collection.
if grep -Fq '"stagingMergeReviewSupportedR29":true' "$root/RELEASE.json"; then
  grep -Fq '"independentReleaseReviewSupportedR28":true' "$root/RELEASE.json" || {
    echo "R29 requires R28 independent source audit" >&2;exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R29 cannot enable real collection" >&2;exit 3;
  }
  for file in scripts/r29-source-tree.mjs src/guest-r29-staging.mjs \
    src/guest-r29-rollback.mjs src/guest-r29-report.mjs; do
    test -f "$root/$file" || {
      echo "R29 source package incomplete: $file" >&2;exit 3;
    }
  done
fi
# R30 preserves the entire R29 release chain, read-only verification tools
# and fail-closed default collection policy.
if grep -Fq '"independentEvidenceReviewSupportedR30":true' "$root/RELEASE.json"; then
  grep -Fq '"stagingMergeReviewSupportedR29":true' "$root/RELEASE.json" || {
    echo "R30 requires R29 source" >&2;exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R30 must remain non-activating" >&2;exit 3;
  }
  for file in src/guest-r30-source-review.mjs src/guest-r30-evidence.mjs \
    src/guest-r30-probe.mjs src/guest-r30-report.mjs \
    scripts/r30-review-github.mjs; do
    test -f "$root/$file" || {
      echo "R30 release missing $file" >&2;exit 3;
    }
  done
fi
# R31 adds explicit operator-only tools, never a production activation path.
if grep -Fq '"manualStagingOperatorSupportedR31":true' "$root/RELEASE.json"; then
  grep -Fq '"independentEvidenceReviewSupportedR30":true' "$root/RELEASE.json" || {
    echo "R31 needs R30 provenance" >&2; exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R31 must not enable customer collection" >&2; exit 3;
  }
  for f in src/guest-r31-chain.mjs src/guest-r31-dr-review.mjs \
    src/guest-r31-evidence-bundle.mjs src/guest-r31-report.mjs \
    scripts/r31-approved-staging.mjs scripts/r31-review-github.mjs; do
    test -f "$root/$f" || { echo "Missing R31 review module $f" >&2; exit 3; }
  done
fi
# R32 offline cutover evidence is an operator-review feature, not a GO flag.
if grep -Fq '"humanCutoverPreflightSupportedR32":true' "$root/RELEASE.json"; then
  grep -Fq '"manualStagingOperatorSupportedR31":true' "$root/RELEASE.json" || {
    echo "R32 requires R31 complete" >&2; exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R32 may not activate live collection" >&2; exit 3;
  }
  for p in src/guest-r32-source.mjs src/guest-r32-change-window.mjs \
    src/guest-r32-staging-drift.mjs \
    src/guest-r32-recovery-objectives.mjs \
    src/guest-r32-preflight.mjs src/guest-r32-report.mjs \
    scripts/r32-review-github.mjs scripts/r32-offline-preflight.mjs; do
    test -f "$root/$p" || {
      echo "Missing R32 review module $p" >&2; exit 3;
    }
  done
fi
# R33 source-only operator audit; no live collection, deployment or STOP lift.
if grep -Fq '"independentReviewBundleSupportedR33":true' "$root/RELEASE.json"; then
  grep -Fq '"humanCutoverPreflightSupportedR32":true' "$root/RELEASE.json" || {
    echo "R33 requires R32 source" >&2; exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R33 may not enable live guest writes" >&2; exit 3;
  }
  for f in src/guest-r33-source.mjs src/guest-r33-signatures.mjs \
    src/guest-r33-staging-witness.mjs src/guest-r33-rollback-ledger.mjs \
    src/guest-r33-privacy.mjs src/guest-r33-proof-bundle.mjs \
    src/guest-r33-report.mjs scripts/r33-review-github.mjs \
    scripts/r33-offline-review.mjs; do
    test -f "$root/$f" || { echo "Missing R33 module $f" >&2; exit 3; }
  done
fi
# R34 operator release review is source-only and always defaults to NO-GO.
if grep -Fq '"operatorReleaseReviewSupportedR34":true' "$root/RELEASE.json"; then
  grep -Fq '"independentReviewBundleSupportedR33":true' "$root/RELEASE.json" || {
    echo "R34 requires R33 source" >&2; exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R34 may not enable customer writes" >&2; exit 3;
  }
  for f in src/guest-r34-source.mjs src/guest-r34-host-evidence.mjs \
    src/guest-r34-quorum.mjs src/guest-r34-custody.mjs \
    src/guest-r34-client.mjs src/guest-r34-acceptance.mjs \
    src/guest-r34-report.mjs scripts/r34-review-github.mjs \
    scripts/r34-operator-staging.mjs scripts/r34-offline-review.mjs; do
    test -f "$root/$f" || { echo "Missing R34 file $f" >&2; exit 3; }
  done
fi
# R35 byte checks and human review are operator-only; never auto-GO.
if grep -Fq '"byteEvidenceAndHumanReviewSupportedR35":true' "$root/RELEASE.json"; then
  grep -Fq '"operatorReleaseReviewSupportedR34":true' "$root/RELEASE.json" || {
    echo "R35 requires R34 source" >&2; exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R35 may not enable customer writes" >&2; exit 3;
  }
  for f in src/guest-r35-source.mjs src/guest-r35-staging.mjs \
    src/guest-r35-byte-proof.mjs src/guest-r35-archive-bytes.mjs \
    src/guest-r35-document-bytes.mjs src/guest-r35-handoff.mjs \
    src/guest-r35-report.mjs scripts/r35-review-github.mjs \
    scripts/r35-staging-canary.mjs scripts/r35-operator-audit.mjs; do
    test -f "$root/$f" || { echo "Missing R35 file $f" >&2; exit 3; }
  done
fi
# R36 ships only operator tools and a read-only tenant NO-GO report.
if grep -Fq '"manualCodeReviewAndSemanticStagingR36":true' "$root/RELEASE.json"; then
  grep -Fq '"byteEvidenceAndHumanReviewSupportedR35":true' "$root/RELEASE.json" || {
    echo "R36 requires R35 source" >&2; exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R36 must not enable guest writes" >&2; exit 3;
  }
  for f in src/guest-r36-source.mjs src/guest-r36-patch-audit.mjs \
    src/guest-r36-staging-content.mjs src/guest-r36-disposable-restore.mjs \
    src/guest-r36-report.mjs scripts/r36-review-github.mjs \
    scripts/r36-staging-canary.mjs scripts/r36-disposable-restore.mjs; do
    test -f "$root/$f" || { echo "Missing R36 source $f" >&2; exit 3; }
  done
fi
# R37 canary, real PostgreSQL introspection and Docker inspection are
# strictly operator-only. Web API never loads private material.
if grep -Fq '"verifiedCanaryRestoreImageMainR37":true' "$root/RELEASE.json"; then
  grep -Fq '"manualCodeReviewAndSemanticStagingR36":true' "$root/RELEASE.json" || {
    echo "R37 requires R36 source" >&2; exit 3;
  }
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || {
    echo "R37 refuses enabled guest writes" >&2; exit 3;
  }
  for f in src/guest-r37-canary-guard.mjs scripts/r37-canary-preflight.mjs \
    src/guest-r37-dr-verified.mjs scripts/r37-local-dr.mjs \
    src/guest-r37-image-provenance.mjs scripts/r37-verify-container.mjs \
    src/guest-r37-postmerge.mjs scripts/r37-main-gate.mjs \
    src/guest-r37-report.mjs; do
    test -f "$root/$f" || { echo "Missing R37 operator component $f" >&2; exit 3; }
  done
fi
# R38 local operator-only rendered Compose and full public-schema DR guards.
if grep -Fq '"resolvedComposeAndDbReviewR38":true' "$root/RELEASE.json"; then
  grep -Fq '"verifiedCanaryRestoreImageMainR37":true' "$root/RELEASE.json" || exit 3
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || exit 3
  for f in src/guest-r38-compose-runtime.mjs scripts/r38-check-compose.mjs \
    src/guest-r38-dr-safety.mjs src/guest-r38-review-policy.mjs \
    src/guest-r38-rollout-evidence.mjs scripts/r38-github-review.mjs; do
    test -f "$root/$f" || { echo "Missing R38 file $f" >&2; exit 3; }
  done
fi
# R39 direct restore safeguards and independent reviewer packet.
if grep -Fq '"operatorDrAndPrReviewR39":true' "$root/RELEASE.json"; then
  grep -Fq '"resolvedComposeAndDbReviewR38":true' "$root/RELEASE.json" || exit 3
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || exit 3
  for f in src/guest-r39-dr-guard.mjs scripts/r39-dr-preflight.mjs \
    src/guest-r39-compose-boundaries.mjs \
    src/guest-r39-review-packet.mjs scripts/r39-first-pr-review.mjs \
    src/guest-r39-operator-handoff.mjs scripts/r39-operator-handoff.mjs; do
    test -f "$root/$f" || { echo "Missing R39 source component $f" >&2; exit 3; }
  done
  grep -Fq 'pg_restore --single-transaction' "$root/ops/restore-dr.sh" || exit 3
  grep -Fq 'r39-dr-preflight.mjs' "$root/ops/restore-dr.sh" || exit 3
fi
# R40 implements safeguards in R14 admission, AGE restore and PR47 review.
if grep -Fq '"safeAdmissionArchivePatchR40":true' "$root/RELEASE.json"; then
  grep -Fq '"operatorDrAndPrReviewR39":true' "$root/RELEASE.json" || exit 3
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || exit 3
  for f in src/guest-r40-secure-files.mjs \
    src/guest-r40-admission-timeline.mjs \
    src/guest-r40-archive-integrity.mjs scripts/r40-archive-check.mjs \
    src/guest-r40-patch-integrity.mjs; do
    test -f "$root/$f" || { echo "Missing R40 safeguard $f" >&2; exit 3; }
  done
  grep -Fq 'readR40Regular' "$root/scripts/r14-admission.mjs" || exit 3
  grep -Fq 'r40-archive-check.mjs' "$root/ops/restore-dr.sh" || exit 3
  grep -Fq 'inspectR40UnifiedPatch' "$root/src/guest-r39-review-packet.mjs" || exit 3
fi
# R41 hardens the actual R14 signed admission, AGE restore, Compose and
# independent PR47 read-only review routes.
if grep -Fq '"trustedOperatorAndReviewR41":true' "$root/RELEASE.json"; then
  grep -Fq '"safeAdmissionArchivePatchR40":true' "$root/RELEASE.json" || exit 3
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || exit 3
  for f in src/guest-r41-key-pins.mjs \
    src/guest-r41-age-snapshot.mjs scripts/r41-snapshot-age.mjs \
    src/guest-r41-git-tree.mjs \
    src/guest-r41-review-gate.mjs scripts/r41-first-pr-gate.mjs; do
    test -f "$root/$f" || { echo "Missing R41 source $f" >&2; exit 3; }
  done
  grep -Fq 'verifyR41KeyPins' "$root/scripts/r14-admission.mjs" || exit 3
  grep -Fq 'r41-snapshot-age.mjs' "$root/ops/restore-dr.sh" || exit 3
  grep -Fq 'openR40Regular' "$root/scripts/r38-check-compose.mjs" || exit 3
fi
# R42 explicitly separates read-only GitHub evidence, synthetic local
# encrypted backups, signed custody claims and generated npm lock review.
if grep -Fq '"readOnlyMergeAndSignedBackupReviewR42":true' "$root/RELEASE.json"; then
  grep -Fq '"trustedOperatorAndReviewR41":true' "$root/RELEASE.json" || exit 3
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || exit 3
  for f in src/guest-r42-merge-drift.mjs scripts/r42-merge-audit.mjs \
    src/guest-r42-backup-guard.mjs scripts/r42-backup-preflight.mjs \
    src/guest-r42-custody-proof.mjs scripts/r42-verify-custody.mjs \
    src/guest-r42-dependency-audit.mjs scripts/r42-deps-review.mjs; do
    test -f "$root/$f" || { echo "Missing R42 file: $f" >&2; exit 3; }
  done
  grep -Fq 'r42-backup-preflight.mjs' "$root/ops/backup-encrypted.sh" || exit 3
  grep -Fq 'ln "$temp_dir/$name"' "$root/ops/backup-encrypted.sh" || exit 3
fi
# R43 exact lock bytes, dependency policy, Docker build context and no writes.
if grep -Fq '"committedDependencyLockAndImageSmokeR43":true' "$root/RELEASE.json"; then
  grep -Fq '"readOnlyMergeAndSignedBackupReviewR42":true' "$root/RELEASE.json" || exit 3
  grep -Fq '"guestWritesDefault":false' "$root/RELEASE.json" || exit 3
  test -f "$root/package-lock.json" && test -f "$root/.dockerignore" || exit 3
  printf '%s  %s\n' 'd0453f56f370d9d5822ccb2116148e56f07acaccff66deb01d5fc280cbc4321a' "$root/package-lock.json" | sha256sum --check --status || {
    echo 'R43 committed npm lock identity mismatch' >&2; exit 3;
  }
  grep -Fq 'npm ci --omit=dev --ignore-scripts' "$root/Dockerfile" || exit 3
  for f in src/guest-r43-lock.mjs src/guest-r43-audit-policy.mjs \
    src/guest-r43-review-chain.mjs scripts/r43-supply-verify.mjs \
    scripts/r43-review-chain.mjs; do
    test -f "$root/$f" || { echo "Missing R43 source: $f" >&2; exit 3; }
  done
fi
if find "$root" -type l -print -quit | grep -q .; then
  echo "Archive contains links" >&2; exit 3
fi
if find "$root" -type f \( -name .env -o -name '*.key' -o -name '*.pem' \
    -o -name '*.age' -o -name identity.txt \) -print -quit | grep -q .; then
  echo "Archive contains credential-shaped file" >&2; exit 3
fi
(
  cd "$root"
  sha256sum -c -- SHA256SUMS >/dev/null
  entries="$(wc -l < SHA256SUMS)"
  actual="$(find . -type f ! -name SHA256SUMS | wc -l)"
  test "$entries" -eq "$actual" || { echo "Unexpected files in bundle" >&2; exit 3; }
)
echo "R14 release integrity: verified $name"
echo "Next step is operator staging, not production deployment."
