/**
 * R46 immutable 32-PR R14..R45 stack with exact source/branch identity.
 * A complete source inventory is never equivalent to independent approval,
 * protected-branch policy, post-merge main CI or customer GO.
 */
import {createHash} from 'node:crypto';
import {R45_ALL_STACK} from './guest-r45-manual-gate.mjs';

export const R46_GRAPH_SCHEMA='osmanx.guest.r46.32-source-head-inventory.v1';
export const R46_LAST=Object.freeze({
 number:94,
 base:'feat/guest-r44-complete-review-offline-supply-proof-20261120',
 head:'feat/guest-r45-commit-proof-merge-preview-ci-review-20261120',
 sha:'8dedf940900798c3ba726884fb952bc7ef397e4e'
});
export const R46_PINNED_STACK=Object.freeze([...R45_ALL_STACK,R46_LAST]);
const SHA=/^[a-f0-9]{40}$/;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

export function assessR46SourceGraph({prs,mainBefore,mainAfter}={}){
 const blockers=[],seen=new Map();
 if(!Array.isArray(prs)||prs.length!==R46_PINNED_STACK.length)
   blockers.push('SOURCE_PR_COUNT_NOT_32');
 for(const p of Array.isArray(prs)?prs:[]){
   if(!Number.isInteger(p?.number)||seen.has(p.number))
     blockers.push('DUPLICATE_OR_MISSING_PR_ID');
   else seen.set(p.number,p);
 }
 const queue=[];
 for(let i=0;i<R46_PINNED_STACK.length;i++){
   const expected=R46_PINNED_STACK[i],p=seen.get(expected.number);
   if(i===0&&expected.base!=='main'||
     i>0&&expected.base!==R46_PINNED_STACK[i-1].head)
     blockers.push('PINNED_BRANCH_CHAIN_BROKEN');
   const sourceValid=!!p&&p.number===expected.number&&
     p.state==='open'&&p.merged===false&&
     p.head?.sha===expected.sha&&p.head?.ref===expected.head&&
     p.base?.ref===expected.base&&SHA.test(p.head.sha);
   if(!sourceValid)blockers.push('PR_'+expected.number+'_SOURCE_DRIFT');
   queue.push({number:expected.number,releaseIndex:i+14,
     expectedSha:expected.sha,sourceValid,
     draft:p?.draft!==false,reviewedAndApproved:false,
     manualMergeAuthorized:false});
 }
 const main=mainBefore?.ref==='refs/heads/main'?mainBefore.object?.sha:null;
 if(!SHA.test(main||'')||mainAfter?.ref!=='refs/heads/main'||
   mainAfter.object?.sha!==main)
   blockers.push('CURRENT_MAIN_SHA_CHANGED_OR_UNVERIFIED');
 const result={schema:R46_GRAPH_SCHEMA,checked:queue.length,
   expected:32,matchingSourceHeads:queue.filter(x=>x.sourceValid).length,
   firstManualReviewPr:47,mainSha:SHA.test(main||'')?main:null,
   queue,blockers:[...new Set(blockers)],
   reviewedAllSources:false,automaticMergeAllowed:false,
   githubWrites:0,productionAuthorized:false,customerGo:false};
 return {...result,sha256:hash(result)};
}
