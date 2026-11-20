/**
 * R43 read-only handoff for the first PR #47 + recent stacked PRs.
 * This is NOT the complete older R14-R37 chain. No automatic merges.
 */
import {createHash} from 'node:crypto';
export const R43_CHAIN_SCHEMA='osmanx.guest.r43.human-review-merge-order.v1';
const SHA=/^[0-9a-f]{40}$/;
export const R43_SELECTED_STACK=Object.freeze([
 {number:47,base:'main',head:'feat/guest-r14-production-operations-20261118',
  sha:'840bb083e606058a9a32450f3b3a3e881a34891e'},
 {number:74,base:'feat/guest-r37-canary-restore-image-postmerge-20261120',
  head:'feat/guest-r38-runtime-guard-dr-merge-evidence-20261120',
  sha:'6fc45799cd9e5fb92216d3ae094aff6166241d97'},
 {number:76,base:'feat/guest-r38-runtime-guard-dr-merge-evidence-20261120',
  head:'feat/guest-r39-direct-dr-transaction-compose-review-20261120',
  sha:'e3e64642f679e4cc5bff56a98a96d4ee7d56221d'},
 {number:77,base:'feat/guest-r39-direct-dr-transaction-compose-review-20261120',
  head:'feat/guest-r40-safe-admission-archive-compose-review-20261120',
  sha:'5c9b1c4c3396c9ebaecbf605702eceff7a1a04a4'},
 {number:79,base:'feat/guest-r40-safe-admission-archive-compose-review-20261120',
  head:'feat/guest-r41-key-pin-fd-snapshot-review-gate-20261120',
  sha:'72e8e709fc53368457f302565d71f4302a358085'},
 {number:81,base:'feat/guest-r41-key-pin-fd-snapshot-review-gate-20261120',
  head:'feat/guest-r42-merge-proof-backup-custody-dependency-audit-20261120',
  sha:'783f4ae4f06df441db521438812881b83a2b2554'},
 {number:84,base:'feat/guest-r42-merge-proof-backup-custody-dependency-audit-20261120',
  head:'feat/guest-r43-locked-supply-chain-review-smoke-20261120'}
]);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function evaluateR43ReviewChain({prs,mainFirst,mainLast,reviews=[],compare}={}){
 const blockers=[],map=new Map();
 if(!Array.isArray(prs)||prs.length!==R43_SELECTED_STACK.length)
   blockers.push('INCOMPLETE_SELECTED_PR_INVENTORY');
 for(const p of Array.isArray(prs)?prs:[]){
   if(!Number.isInteger(p?.number)||map.has(p.number))
     blockers.push('DUPLICATED_OR_UNIDENTIFIED_PR');
   else map.set(p.number,p);
 }
 const actual=[];
 for(const item of R43_SELECTED_STACK){
   const p=map.get(item.number);
   const aligned=p?.state==='open'&&p?.merged===false&&
     p?.head?.ref===item.head&&p?.base?.ref===item.base&&
     SHA.test(p?.head?.sha||'')&&(!item.sha||p.head.sha===item.sha);
   if(!aligned)blockers.push('PR_'+item.number+'_HEAD_BASE_OR_STATE_DRIFT');
   actual.push({number:item.number,headRef:item.head,baseRef:item.base,
     pinnedHead:item.sha||null,observedSha:p?.head?.sha||null,
     draft:p?.draft===true,open:p?.state==='open',aligned:!!aligned});
 }
 const mainSha=mainFirst?.object?.sha;
 if(!SHA.test(mainSha||'')||mainFirst?.ref!=='refs/heads/main'||
   mainLast?.object?.sha!==mainSha)
   blockers.push('MAIN_MOVED_OR_NOT_VERIFIED');
 if(!compare||compare?.base_commit?.sha!==mainSha||
   !Number.isSafeInteger(compare.behind_by)||compare.behind_by<0||
   !Number.isSafeInteger(compare.ahead_by)||compare.ahead_by<0||
   !['ahead','behind','diverged','identical'].includes(compare.status))
   blockers.push('FIRST_PR_MAIN_COMPARISON_UNVERIFIED');
 const behind=Number.isSafeInteger(compare?.behind_by)?compare.behind_by:null;
 if(behind!==0)blockers.push('PR47_MUST_RECONCILE_MAIN_BEFORE_APPROVAL');
 const first=map.get(47);
 if(first?.draft!==false)blockers.push('PR47_REMAINS_DRAFT');
 const independentApproved=Array.isArray(reviews)&&reviews.some(r=>
   r?.state==='APPROVED'&&r?.commit_id===first?.head?.sha&&
   r?.user?.login&&r.user.login!==first?.user?.login);
 if(!independentApproved)blockers.push('NO_INDEPENDENT_REVIEW_OF_CURRENT_PR47_SHA');
 const body={schema:R43_CHAIN_SCHEMA,
   mainSha:SHA.test(mainSha||'')?mainSha:null,
   firstPrSha:first?.head?.sha||null,
   selectedPrsExpected:R43_SELECTED_STACK.length,
   selectedPrsVerified:actual.filter(x=>x.aligned).length,
   fullPredecessorChainVerified:false,behindMain:behind,
   independentApprovalOnCurrentFirstPr:independentApproved,
   firstManualReviewPr:47,queue:actual,
   operatorSequence:[
     'Independent R14 PR47 review on CURRENT SHA after reconciling main',
     'Review all R15-R37 predecessor PRs and verify source/CI trees',
     'Review R38-R43 stacked branches in PR dependency order',
     'Never merge while draft or without independent current-head approvals',
     'After human merges, run complete CI on freshly observed main SHA',
     'Witness actual staging, offsite DR/rollback and lawful customer authority'
   ],githubReadsOnly:true,githubWrites:0,
   automaticMergeAllowed:false,productionAuthorized:false,
   customerGo:false,stopLifted:false,blockers:[...new Set(blockers)]};
 return {...body,sha256:hash(body)};
}
export function r43ReviewMarkdown(p){
 if(p?.schema!==R43_CHAIN_SCHEMA||p?.productionAuthorized!==false)
   throw Error('R43 reviewer packet NO-GO');
 return ['# OSMANX Guest Intelligence — manual PR review and merge sequence','',
   'Verified main SHA: '+(p.mainSha||'UNKNOWN'),
   'First PR #47 behind main: '+(p.behindMain??'UNKNOWN')+' commits',
   'Selected PRs verified: '+p.selectedPrsVerified+'/'+p.selectedPrsExpected,
   '**Selected PRs are not the entire chain.**','',
   '## Pinned PR queue',
   ...p.queue.map(x=>'- PR #'+x.number+' '+x.headRef+' to '+x.baseRef+
     ' | source '+(x.observedSha||'MISSING')+' | '+(x.aligned?'PINNED':'DRIFT')),
   '','## Human steps',...p.operatorSequence.map((s,i)=>(i+1)+'. '+s),
   '','## Blockers',...p.blockers.map(s=>'- '+s),
   '','**NO MERGE, NO PRODUCTION, NO CUSTOMER WRITES.**',''].join('\n');
}
