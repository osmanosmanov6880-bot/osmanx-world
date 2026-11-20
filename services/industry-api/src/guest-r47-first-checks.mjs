/**
 * R47 verify actual first-PR required workflow job, not merely "some green".
 * Complete one-page GitHub Checks API required. Missing/skipped/pending fail.
 */
import {R47_FIRST_PR} from './guest-r47-source-pins.mjs';
export const R47_CHECK_SCHEMA='osmanx.guest.r47.first-pr-required-checks.v1';
export const R47_REQUIRED_CHECKS=Object.freeze(['ops-contract']);
const nameOk=x=>typeof x==='string'&&x.length>=1&&x.length<=160;
export function assessR47FirstChecks(response){
 const blockers=[],runs=response?.check_runs;
 const total=response?.total_count;
 if(!Array.isArray(runs)||!Number.isSafeInteger(total)||total<1||
    total>100||runs?.length!==total)
   blockers.push('CHECK_RUN_RESULT_INCOMPLETE_OR_PAGINATED');
 const relevant=[];
 for(const r of Array.isArray(runs)?runs:[]){
   if(!Number.isSafeInteger(r?.id)||r.id<1||
     !nameOk(r.name)||r.head_sha!==R47_FIRST_PR.sha)
     blockers.push('CHECK_IDENTITY_OR_SOURCE_HEAD_MISMATCH');
   if(r?.app?.slug==='github-actions'){
     relevant.push({
       name:r.name,id:r.id,
       headSha:r.head_sha,status:r.status,
       conclusion:r.conclusion
     });
     if(r.status!=='completed'||r.conclusion!=='success')
       blockers.push('UNSUCCESSFUL_OR_SKIPPED_GITHUB_ACTIONS_CHECK');
   }
 }
 for(const required of R47_REQUIRED_CHECKS)
   if(!relevant.some(r=>r.name===required&&
     r.status==='completed'&&r.conclusion==='success'))
     blockers.push('REQUIRED_R14_OPS_CONTRACT_NOT_GREEN');
 if(relevant.length===0)
   blockers.push('NO_GITHUB_ACTIONS_CHECKS_OBSERVED');
 const report={schema:R47_CHECK_SCHEMA,
   sourcePr:47,sha:R47_FIRST_PR.sha,
   requiredChecks:[...R47_REQUIRED_CHECKS],
   requiredCheckPolicyPassed:blockers.length===0,
   observedChecks:relevant.slice(0,100),
   exactSourceSHARequired:true,
   independentReviewProvided:false,
   postMergeMainCiVerified:false,productionAuthorized:false,
   blockers:[...new Set(blockers)]};
 return report;
}
