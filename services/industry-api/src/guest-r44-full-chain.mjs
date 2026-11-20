/**
 * R44 immutable COMPLETE R14..R43 stacked source inventory (30 selected PRs).
 * GitHub is queried with GET only. A verified source tree is never human
 * approval, refreshed main CI, staged recovery, or production authorization.
 */
import {createHash} from 'node:crypto';

export const R44_GRAPH_SCHEMA='osmanx.guest.r44.complete-manual-release-review.v1';
export const R44_PINNED_STACK=Object.freeze([
  {
    "number": 47,
    "base": "main",
    "head": "feat/guest-r14-production-operations-20261118",
    "sha": "840bb083e606058a9a32450f3b3a3e881a34891e"
  },
  {
    "number": 48,
    "base": "feat/guest-r14-production-operations-20261118",
    "head": "feat/guest-r15-tenant-admission-20261119",
    "sha": "125df326215494f1f690db6afbe1a796bcf3509a"
  },
  {
    "number": 49,
    "base": "feat/guest-r15-tenant-admission-20261119",
    "head": "feat/guest-r16-multitenant-revocation-20261119",
    "sha": "be2fa8391a6fc837e63bee98acaa010429f410cc"
  },
  {
    "number": 51,
    "base": "feat/guest-r16-multitenant-revocation-20261119",
    "head": "feat/guest-r17-witness-fence-onboarding-20261119",
    "sha": "73ade05c91216913febd5ab4da2fc9a3694c1f84"
  },
  {
    "number": 52,
    "base": "feat/guest-r17-witness-fence-onboarding-20261119",
    "head": "feat/guest-r18-external-anchor-recovery-20261119",
    "sha": "8418a02718610fbc0728460437b457afb44c951c"
  },
  {
    "number": 53,
    "base": "feat/guest-r18-external-anchor-recovery-20261119",
    "head": "feat/guest-r19-single-pilot-controlled-rollout-20261119",
    "sha": "3f43ffe7ac94a5d598f1df1a7701a3ccf45c1136"
  },
  {
    "number": 54,
    "base": "feat/guest-r19-single-pilot-controlled-rollout-20261119",
    "head": "feat/guest-r20-release-control-dr-20261119",
    "sha": "aac97ee3d55758cc32776284fb69cffb34c94f06"
  },
  {
    "number": 55,
    "base": "feat/guest-r20-release-control-dr-20261119",
    "head": "feat/guest-r21-production-readiness-evidence-20261119",
    "sha": "de63f85daa27fb8dc362c9cd02d1272c192db5ee"
  },
  {
    "number": 56,
    "base": "feat/guest-r21-production-readiness-evidence-20261119",
    "head": "feat/guest-r22-independent-readiness-20261119",
    "sha": "0bf8212fefc7a8fda969a34230866dd1cbee133c"
  },
  {
    "number": 57,
    "base": "feat/guest-r22-independent-readiness-20261119",
    "head": "feat/guest-r23-controlled-merge-staging-20261119",
    "sha": "504f176ff5929e2a37bd799bd1c39f24225665be"
  },
  {
    "number": 58,
    "base": "feat/guest-r23-controlled-merge-staging-20261119",
    "head": "feat/guest-r24-decision-intelligence-20261119",
    "sha": "8c6b061de4f692432d385aa3d8365334b0ec7201"
  },
  {
    "number": 59,
    "base": "feat/guest-r24-decision-intelligence-20261119",
    "head": "feat/guest-r25-operational-barriers-20261119",
    "sha": "12c616f28f11e030687462cb92b28535e1bfe5a6"
  },
  {
    "number": 60,
    "base": "feat/guest-r25-operational-barriers-20261119",
    "head": "feat/guest-r26-source-reliability-20261119",
    "sha": "d87bb630f8de3c7ef2d71ffe1804cc2fdecf2b76"
  },
  {
    "number": 61,
    "base": "feat/guest-r26-source-reliability-20261119",
    "head": "feat/guest-r27-first-client-rehearsal-20261119",
    "sha": "b9cec9ac37fc3dd655fcb19ba3abbe33a5827d54"
  },
  {
    "number": 62,
    "base": "feat/guest-r27-first-client-rehearsal-20261119",
    "head": "feat/guest-r28-independent-release-review-20261119",
    "sha": "f9f73acbef0ba63f7f2706f87a1b0ee8b4cfdc7d"
  },
  {
    "number": 64,
    "base": "feat/guest-r28-independent-release-review-20261119",
    "head": "feat/guest-r29-merge-staging-acceptance-20261119",
    "sha": "7b2e9a60765a08b0662b332378958147431783ab"
  },
  {
    "number": 65,
    "base": "feat/guest-r29-merge-staging-acceptance-20261119",
    "head": "feat/guest-r30-independent-evidence-review-20261119",
    "sha": "658bc5ac937e088d7a9d50b7946426d2b82b92f4"
  },
  {
    "number": 66,
    "base": "feat/guest-r30-independent-evidence-review-20261119",
    "head": "feat/guest-r31-operator-staging-evidence-20261119",
    "sha": "0e39e243162dd48c84eb790539d97439e969a65a"
  },
  {
    "number": 67,
    "base": "feat/guest-r31-operator-staging-evidence-20261119",
    "head": "feat/guest-r32-human-cutover-preflight-20261119",
    "sha": "1c1c7047cd1d197fea0289857b2bacee141baaea"
  },
  {
    "number": 68,
    "base": "feat/guest-r32-human-cutover-preflight-20261119",
    "head": "feat/guest-r33-verified-staging-rollback-privacy-20261119",
    "sha": "9957b916a3e72fbf7aba73d0e9da0f176013a037"
  },
  {
    "number": 69,
    "base": "feat/guest-r33-verified-staging-rollback-privacy-20261119",
    "head": "feat/guest-r34-staging-evidence-and-review-20261120",
    "sha": "d1c072296f48047a494de3629fcb6758b8e7216b"
  },
  {
    "number": 70,
    "base": "feat/guest-r34-staging-evidence-and-review-20261120",
    "head": "feat/guest-r35-manual-merge-verified-host-evidence-20261120",
    "sha": "3e4d0609950fbc315947481cf4e431a0afe87e67"
  },
  {
    "number": 71,
    "base": "feat/guest-r35-manual-merge-verified-host-evidence-20261120",
    "head": "feat/guest-r36-first-human-review-staging-dr-20261120",
    "sha": "8da6192969ec8a5d1d1523a6a605ba04d5299718"
  },
  {
    "number": 72,
    "base": "feat/guest-r36-first-human-review-staging-dr-20261120",
    "head": "feat/guest-r37-canary-restore-image-postmerge-20261120",
    "sha": "a9f6cb0b7a9c6af6d005b5a634a1c277b42e8d5f"
  },
  {
    "number": 74,
    "base": "feat/guest-r37-canary-restore-image-postmerge-20261120",
    "head": "feat/guest-r38-runtime-guard-dr-merge-evidence-20261120",
    "sha": "6fc45799cd9e5fb92216d3ae094aff6166241d97"
  },
  {
    "number": 76,
    "base": "feat/guest-r38-runtime-guard-dr-merge-evidence-20261120",
    "head": "feat/guest-r39-direct-dr-transaction-compose-review-20261120",
    "sha": "e3e64642f679e4cc5bff56a98a96d4ee7d56221d"
  },
  {
    "number": 77,
    "base": "feat/guest-r39-direct-dr-transaction-compose-review-20261120",
    "head": "feat/guest-r40-safe-admission-archive-compose-review-20261120",
    "sha": "5c9b1c4c3396c9ebaecbf605702eceff7a1a04a4"
  },
  {
    "number": 79,
    "base": "feat/guest-r40-safe-admission-archive-compose-review-20261120",
    "head": "feat/guest-r41-key-pin-fd-snapshot-review-gate-20261120",
    "sha": "72e8e709fc53368457f302565d71f4302a358085"
  },
  {
    "number": 81,
    "base": "feat/guest-r41-key-pin-fd-snapshot-review-gate-20261120",
    "head": "feat/guest-r42-merge-proof-backup-custody-dependency-audit-20261120",
    "sha": "783f4ae4f06df441db521438812881b83a2b2554"
  },
  {
    "number": 84,
    "base": "feat/guest-r42-merge-proof-backup-custody-dependency-audit-20261120",
    "head": "feat/guest-r43-locked-supply-chain-review-smoke-20261120",
    "sha": "4ea60653fb724f99a44b8bfbb71477233c189c0f"
  }
]);
const SHA=/^[0-9a-f]{40}$/;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const validDate=s=>typeof s==='string'&&Number.isFinite(Date.parse(s));

export function evaluateR44Reviews(pr,reviews){
 const reasons=[];
 if(!Array.isArray(reviews)||reviews.length>100){
   return {approved:false,reviewer:null,reasons:['REVIEW_PAGINATION_OR_SHAPE_UNVERIFIED']};
 }
 const latest=new Map();
 const sortable=[];
 for(const r of reviews){
   if(!r||!r.user||typeof r.user.login!=='string'||!validDate(r.submitted_at)){
     reasons.push('REVIEW_IDENTITY_OR_DATE_UNVERIFIED');
     continue;
   }
   if(!['APPROVED','CHANGES_REQUESTED','DISMISSED','COMMENTED','PENDING'].includes(r.state)){
     reasons.push('UNKNOWN_REVIEW_STATE');
     continue;
   }
   sortable.push(r);
 }
 sortable.sort((a,b)=>Date.parse(a.submitted_at)-Date.parse(b.submitted_at)||
   (Number(a.id)||0)-(Number(b.id)||0));
 for(const r of sortable){
   if(['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(r.state))
     latest.set(r.user.login,r);
 }
 const accepted=[];
 for(const [login,r] of latest){
   if(login===pr?.user?.login||r.user?.type==='Bot'||login.endsWith('[bot]'))continue;
   if(r.state==='CHANGES_REQUESTED')reasons.push('ACTIVE_CHANGES_REQUESTED');
   if(r.state==='APPROVED'){
     if(r.commit_id!==pr?.head?.sha)reasons.push('APPROVAL_NOT_FOR_CURRENT_HEAD');
     else accepted.push(login);
   }
 }
 if(accepted.length===0)reasons.push('NO_INDEPENDENT_CURRENT_HEAD_APPROVAL');
 return {approved:accepted.length>0&&reasons.length===0,
   reviewer:accepted.length>0?accepted[0]:null,reasons:[...new Set(reasons)]};
}

export function evaluateR44FullChain({
 prs=[],reviewsByNumber={},mainBefore,mainAfter,compare,protection
}={}){
 const blockers=[],byNumber=new Map(),queue=[];
 if(!Array.isArray(prs)||prs.length!==R44_PINNED_STACK.length)
   blockers.push('NOT_ALL_30_PR_RESPONSES_RECEIVED');
 for(const p of Array.isArray(prs)?prs:[]){
   if(!Number.isInteger(p?.number)||byNumber.has(p.number))
     blockers.push('DUPLICATE_OR_INVALID_PR_NUMBER');
   else byNumber.set(p.number,p);
 }
 let firstBlocked=null,prior=null;
 for(const expected of R44_PINNED_STACK){
   const p=byNumber.get(expected.number);
   const sourceVerified=!!p&&p.number===expected.number&&
     p.state==='open'&&p.merged===false&&
     p.base?.ref===expected.base&&p.head?.ref===expected.head&&
     p.head?.sha===expected.sha&&SHA.test(p.head.sha);
   const linked=prior===null?expected.base==='main':expected.base===prior.head;
   if(!linked)blockers.push('PINNED_SOURCE_GRAPH_INVALID');
   const reviews=evaluateR44Reviews(p,reviewsByNumber?.[expected.number]);
   const reasons=[];
   if(!sourceVerified)reasons.push('SOURCE_REF_SHA_STATE_DRIFT');
   if(p?.draft!==false)reasons.push('PR_STILL_DRAFT');
   reasons.push(...reviews.reasons);
   if(reasons.length>0&&firstBlocked===null)firstBlocked=expected.number;
   queue.push({number:expected.number,head:expected.head,base:expected.base,
     pinnedSha:expected.sha,observedSha:p?.head?.sha||null,
     sourceVerified,linked,draft:p?.draft!==false,
     independentCurrentShaApproval:reviews.approved,reviewer:reviews.reviewer,
     reasons:[...new Set(reasons)]});
   prior=expected;
 }
 if(!R44_PINNED_STACK.every((x,i)=>queue[i]?.sourceVerified))
   blockers.push('ONE_OR_MORE_PINNED_PR_HEADS_DRIFTED');
 const mainSha=mainBefore?.ref==='refs/heads/main'?mainBefore?.object?.sha:null;
 if(!SHA.test(mainSha||'')||mainAfter?.object?.sha!==mainSha||
   mainAfter?.ref!=='refs/heads/main')blockers.push('MAIN_MOVED_OR_UNVERIFIED');
 if(compare?.base_commit?.sha!==mainSha||
   compare?.head_commit?.sha!==R44_PINNED_STACK[0].sha||
   !Number.isSafeInteger(compare?.behind_by)||compare.behind_by<0||
   !Number.isSafeInteger(compare?.ahead_by)||compare.ahead_by<0||
   !['ahead','behind','diverged','identical'].includes(compare?.status))
   blockers.push('PR47_CURRENT_MAIN_COMPARISON_UNVERIFIED');
 const behind=Number.isSafeInteger(compare?.behind_by)?compare.behind_by:null;
 if(behind!==0)blockers.push('PR47_BEHIND_OR_UNVERIFIED_MAIN');
 const protectionReadable=protection?.status===200&&
   protection?.data!==null&&typeof protection?.data==='object';
 if(!protectionReadable)blockers.push('MAIN_PROTECTION_UNVERIFIED');
 if(queue.some(q=>q.draft))blockers.push('DRAFT_PRS_AWAIT_HUMAN_REVIEW');
 if(queue.some(q=>!q.independentCurrentShaApproval))
   blockers.push('INDEPENDENT_CURRENT_HEAD_APPROVALS_MISSING');
 const record={
   schema:R44_GRAPH_SCHEMA,
   expectedPrs:30,receivedPrs:byNumber.size,
   verifiedSourcePrs:queue.filter(q=>q.sourceVerified).length,
   fullPredecessorChainInspected:true,
   firstManualBlockerPr:firstBlocked,
   mainSha:SHA.test(mainSha||'')?mainSha:null,
   firstPrBehindMain:behind,
   mainProtectionReadable:protectionReadable,
   sourceGraphPinned:true,
   reviewCompleted:queue.every(q=>q.independentCurrentShaApproval&&!q.draft),
   queue,blockers:[...new Set(blockers)],
   decisions:{readOnlyGitHub:true,githubWrites:0,
     noAutomaticMerge:true,fullPostMergeMainCiObserved:false,
     realStagingAndOffsiteRestoreObserved:false,
     customerGo:false,productionAuthorized:false}
 };
 return {...record,sha256:digest(record)};
}
export function renderR44ReviewerMarkdown(report){
 if(report?.schema!==R44_GRAPH_SCHEMA||
   report.decisions?.productionAuthorized!==false||
   report.decisions?.githubWrites!==0)throw Error('INVALID_R44_NO_GO_PACKET');
 const lines=['# OSMANX Guest Intelligence — independent R14–R43 release handoff','',
   'Complete selected chain: '+report.verifiedSourcePrs+'/'+report.expectedPrs+
   ' source SHAs; this is not equivalent to an approved/merged release.',
   'Current main SHA: '+(report.mainSha||'UNVERIFIED'),
   'First PR #47 behind main: '+(report.firstPrBehindMain??'UNVERIFIED'),
   'Branch protection API readable: '+report.mainProtectionReadable,
   'First manual blocker: PR #'+(report.firstManualBlockerPr??'UNVERIFIED'),'',
   '## Ordered independent review queue'];
 for(const q of report.queue)
   lines.push('- #'+q.number+' | '+q.pinnedSha+' | source '+
     (q.sourceVerified?'MATCH':'DRIFT')+' | '+(q.draft?'DRAFT':'READY')+
     ' | review '+(q.independentCurrentShaApproval?'CURRENT HEAD':'MISSING/STALE')+
     ' | '+q.reasons.join(', '));
 lines.push('','## Explicit blockers',...report.blockers.map(x=>'- '+x),'',
   'Review from PR #47 upward; manually reconcile main and all intervening PRs.',
   'A different independent human must approve each CURRENT head. Merge sequentially ONLY after required checks.',
   'After all merges, validate fresh main CI, authorized staging, offsite recovery and lawful pilot scope.',
   '**NO AUTOMATIC MERGE. NO PRODUCTION. NO CUSTOMER WRITES.**','');
 return lines.join('\n');
}
