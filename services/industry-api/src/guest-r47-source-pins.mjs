/**
 * R47 first-PR review evidence: exact historical Git tree blobs.
 * Blob identity does not assert implementation quality or runtime safety.
 */
import {createHash} from 'node:crypto';
export const R47_SOURCE_SCHEMA='osmanx.guest.r47.first-pr-source-pins.v1';
export const R47_FIRST_PR=Object.freeze({
  number:47,sha:'840bb083e606058a9a32450f3b3a3e881a34891e',
  head:'feat/guest-r14-production-operations-20261118',base:'main'
});
export const R47_SOURCE_FILES=Object.freeze({
  ".github/workflows/guest-r14-operations.yml": "a70f456c084fa2673e87e150779ee5ca94e1fe3e",
  "docs/GUEST_INTELLIGENCE_R14.md": "316a78eec51e14fda6501d87c881fbf7bf743103",
  "services/industry-api/ops/build-release.sh": "8396853cbe759cd5c364d65378e5aca8ea5a70a9",
  "services/industry-api/ops/compose.r14.yml": "afb8cc7540bac61975252589e5d391536015d56b",
  "services/industry-api/ops/r14-canary.sh": "aafa2b789671c0176ea2c91079fee9b3eb5c0467",
  "services/industry-api/ops/verify-release.sh": "e12b87aada522e41d7d3faa5cf00a0b7deee2d07",
  "services/industry-api/scripts/r14-admission.mjs": "bf9df74caa0b1a9e83e0331bf78dd83582640ee9",
  "services/industry-api/scripts/r14-incident.mjs": "c6ac9578265ed96a660596033b06612439a514cc",
  "services/industry-api/scripts/r14-monitor.mjs": "8c9c092e9a4a8d3881de0b03ea6aeaac196f0797",
  "services/industry-api/test/guest-r14.test.mjs": "49ef1374febaed4fa0cc011b51bbe4361822c995"
});
const SHA=/^[a-f0-9]{40}$/;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function assessR47SourcePins({commitSha,blobShaByPath,changedPaths=[]}={}){
  const blockers=[],expected=Object.entries(R47_SOURCE_FILES);
  if(commitSha!==R47_FIRST_PR.sha)blockers.push('FIRST_PR_COMMIT_NOT_PINNED');
  if(!blobShaByPath||typeof blobShaByPath!=='object'||Array.isArray(blobShaByPath))
    blockers.push('BLOB_SHA_INVENTORY_ABSENT');
  if(!Array.isArray(changedPaths)||changedPaths.length!==expected.length||
     changedPaths.some(x=>typeof x!=='string')||
     new Set(changedPaths).size!==expected.length||
     expected.some(([path])=>!changedPaths.includes(path)))
    blockers.push('FIRST_PR_EXACT_TEN_FILE_DIFF_UNVERIFIED');
  const actual=blobShaByPath&&typeof blobShaByPath==='object'&&!Array.isArray(blobShaByPath)?
    blobShaByPath:{};
  if(Object.keys(actual).length!==expected.length ||
     expected.some(([path,sha])=>!SHA.test(actual[path]||'')||actual[path]!==sha))
    blockers.push('FIRST_PR_FILE_BLOB_BYTES_DIFFER_FROM_PINNED_SOURCE');
  const report={schema:R47_SOURCE_SCHEMA,
    commitSha:R47_FIRST_PR.sha,sourcePr:47,filesExpected:expected.length,
    exactHistoricalBytesVerified:blockers.length===0,
    blobMatches:expected.filter(([path,sha])=>actual[path]===sha).length,
    changedPathsVerified:!blockers.includes('FIRST_PR_EXACT_TEN_FILE_DIFF_UNVERIFIED'),
    files:expected.map(([path,sha])=>({path,expectedBlobSha:sha,
      observedBlobSha:actual[path]||null,
      matches:actual[path]===sha})),
    noSourceCodeOrSecretsExported:true,
    independentSecurityReviewCompleted:false,
    automaticMergeAllowed:false,customerGo:false,productionAuthorized:false,
    blockers:[...new Set(blockers)]};
  return {...report,sha256:digest(report)};
}
