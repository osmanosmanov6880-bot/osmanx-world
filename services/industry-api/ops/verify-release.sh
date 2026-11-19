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
