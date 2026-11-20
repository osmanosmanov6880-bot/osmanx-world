/**
 * R45: current-head GitHub Actions check-run provenance, not old PR green.
 * Fail closed on missing pages, changed SHA, incomplete, cancelled and failed
 * runs. Empty checks are not proof that CI ran.
 */
export const R45_CI_SCHEMA='osmanx.guest.r45.current-sha-check-runs.v1';
const SHA=/^[a-f0-9]{40}$/;
const OK=new Set(['success']);
const all=x=>Array.isArray(x)&&x.length>=0;
export function inspectR45CurrentShaChecks({
  prNumber,expectedSha,response
}={}){
 const blockers=[];
 if(!Number.isInteger(prNumber)||prNumber<1||!SHA.test(expectedSha||''))
   blockers.push('INVALID_PINNED_SOURCE');
 const runs=response?.check_runs;
 const total=response?.total_count;
 if(!all(runs)||!Number.isSafeInteger(total)||total<0||
   total>100||runs?.length!==total)
   blockers.push('CHECK_RUN_PAGINATION_OR_TOTAL_UNVERIFIED');
 const selected=[];
 for(const r of all(runs)?runs:[]){
   if(r?.head_sha!==expectedSha)
     blockers.push('CHECK_RUN_SOURCE_SHA_MISMATCH');
   if(!Number.isSafeInteger(r?.id)||r.id<1||
     typeof r?.name!=='string'||r.name.length>160)
     blockers.push('CHECK_RUN_ID_OR_NAME_UNTRUSTED');
   if(r?.app?.slug==='github-actions'){
     selected.push({id:r.id,name:r.name,
       status:r.status,conclusion:r.conclusion});
   }
 }
 if(selected.length===0)
   blockers.push('NO_GITHUB_ACTIONS_CHECK_RUNS_FOR_SOURCE');
 if(selected.some(r=>r.status!=='completed'||!OK.has(r.conclusion)))
   blockers.push('PENDING_FAILED_CANCELLED_OR_SKIPPED_SOURCE_CHECKS');
 const completeEvidence=blockers.length===0;
 return {schema:R45_CI_SCHEMA,prNumber,
   sourceSha:SHA.test(expectedSha||'')?expectedSha:null,
   apiTotal:Number.isSafeInteger(total)?total:null,
   githubActionsChecks:selected.length,
   sourceChecksCompleteAndGreen:completeEvidence,
   sourceCiDoesNotProvePostMergeMain:true,
   currentMainCiChecked:false,
   productionAuthorized:false,
   observedChecks:selected.slice(0,100),
   blockers:[...new Set(blockers)]};
}
export function inspectR45CICoverage(stack,reports){
 const blockers=[],checks=[],seen=new Set();
 if(!Array.isArray(stack)||stack.length!==31)
   blockers.push('UNEXPECTED_R45_STACK_LENGTH');
 for(const expected of Array.isArray(stack)?stack:[]){
   if(!expected||!Number.isInteger(expected.number)||seen.has(expected.number)){
     blockers.push('DUPLICATE_SOURCE_PR');
     continue;
   }
   seen.add(expected.number);
   const report=reports?.[expected.number];
   if(report?.prNumber!==expected.number||
     report?.sourceSha!==expected.sha||
     report?.schema!==R45_CI_SCHEMA)
     blockers.push('MISSING_OR_UNPINNED_PR_CI_REPORT');
   checks.push({number:expected.number,
     green:report?.sourceChecksCompleteAndGreen===true,
     count:report?.githubActionsChecks??0,
     blockers:Array.isArray(report?.blockers)?report.blockers:
       ['CI_REPORT_UNAVAILABLE']});
 }
 return {schema:'osmanx.guest.r45.all-source-ci-coverage.v1',
   requested:31,received:checks.length,
   greenCurrentHead:checks.filter(x=>x.green).length,
   allCurrentSourceCIValidated:checks.length===31&&
     checks.every(x=>x.green)&&blockers.length===0,
   checks,blockers,postMergeMainStillUnverified:true,
   productionAuthorized:false};
}
