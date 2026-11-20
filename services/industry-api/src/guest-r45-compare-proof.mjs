/**
 * R45: correct R44's false negative when GitHub omits head_commit.
 * A separate GET of the exact commit SHA is mandatory.
 * A complete comparison is still NOT a merge authorization.
 */
import {R44_PINNED_STACK} from './guest-r44-full-chain.mjs';
export const R45_COMPARE_SCHEMA='osmanx.guest.r45.independent-compare-proof.v1';
export const R45_FIRST=Object.freeze({...R44_PINNED_STACK[0]});
const SHA=/^[0-9a-f]{40}$/;
const INTEGER=x=>Number.isSafeInteger(x)&&x>=0;
export function verifyR45FirstComparison({
 mainBefore,mainAfter,comparison,firstCommit
}={}){
 const blockers=[];
 const mainSha=mainBefore?.ref==='refs/heads/main'?
   mainBefore?.object?.sha:null;
 if(!SHA.test(mainSha||'')||mainAfter?.ref!=='refs/heads/main'||
   mainAfter?.object?.sha!==mainSha)
   blockers.push('MAIN_MOVED_OR_NOT_VERIFIABLE');
 if(firstCommit?.sha!==R45_FIRST.sha)
   blockers.push('FIRST_PR_COMMIT_IDENTITY_UNVERIFIED');
 if(comparison?.base_commit?.sha!==mainSha||
   !INTEGER(comparison?.ahead_by)||!INTEGER(comparison?.behind_by)||
   !['ahead','behind','diverged','identical'].includes(comparison?.status))
   blockers.push('GITHUB_COMPARE_FIELDS_MISSING_OR_CONFLICTING');
 // A separately retrieved exact /git/commits/{pinnedSha} response proves
 // commit identity even if optional head_commit is absent in comparison.
 if(comparison?.head_commit?.sha!==undefined&&
    comparison.head_commit.sha!==R45_FIRST.sha)
   blockers.push('COMPARE_REPORTED_DIFFERENT_HEAD_COMMIT');
 const status=comparison?.status,ahead=comparison?.ahead_by,behind=comparison?.behind_by;
 if((status==='identical'&&(ahead!==0||behind!==0))||
   (status==='ahead'&&behind!==0)||
   (status==='behind'&&ahead!==0)||
   (status==='diverged'&&!(ahead>0&&behind>0)))
   blockers.push('GITHUB_COMPARE_STATUS_COUNT_CONTRADICTION');
 const evidenceValid=blockers.length===0;
 return {schema:R45_COMPARE_SCHEMA,evidenceValid,
   pinnedFirstPr:R45_FIRST.number,pinnedHead:R45_FIRST.sha,
   independentlyFetchedHead:firstCommit?.sha||null,
   observedMain:SHA.test(mainSha||'')?mainSha:null,
   behindMain:INTEGER(behind)?behind:null,
   aheadMain:INTEGER(ahead)?ahead:null,
   needsManualReconciliation:!evidenceValid||behind!==0,
   readyForAutomaticMerge:false,productionAuthorized:false,
   customerWritesEnabled:false,blockers};
}
