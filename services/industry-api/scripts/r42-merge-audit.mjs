/**
 * R42 GET-only Github first-PR rebase / human approval readiness.
 * The GitHub integration may be denied branch protection (403), and in
 * that case policy remains unknown and release GO stays explicitly false.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchR41FirstPrGate}
  from './r41-first-pr-gate.mjs';
import {inspectR42Merge}
  from '../src/guest-r42-merge-drift.mjs';
const REPO='osmanosmanov6880-bot/osmanx-world';
const PIN='840bb083e606058a9a32450f3b3a3e881a34891e';
export async function fetchR42MergeAudit({repository=REPO,
  token=process.env.GITHUB_TOKEN,fetcher=fetch
}={}){
  if(repository!==REPO)throw Error('R42 pinned repo required');
  const preceding=await fetchR41FirstPrGate({repository,token,fetcher});
  const get=async(path,{allow403=false}={})=>{
    const res=await fetcher('https://api.github.com/repos/'+repository+path,{
      method:'GET',redirect:'error',headers:{
        Accept:'application/vnd.github+json',
        'User-Agent':'osmanx-r42-pr47-merge-audit',
        ...(token?{Authorization:'Bearer '+token}:{})
      }
    });
    if(allow403&&res.status===403)
      return {status:403,data:null};
    if(!res.ok)throw Error('R42 GitHub read failed '+res.status);
    return {status:res.status,data:await res.json()};
  };
  const [prRes,mainRes,protection]=await Promise.all([
    get('/pulls/47'),get('/git/ref/heads/main'),
    get('/branches/main/protection',{allow403:true})
  ]);
  const pr=prRes.data,mainRef=mainRes.data;
  const comparison=await get('/compare/'+mainRef.object.sha+'...'+PIN);
  const mainAfter=(await get('/git/ref/heads/main')).data;
  const merge=inspectR42Merge({
    pr,mainRef,mainAfter,
    compare:comparison.data,protection
  });
  return {schema:'osmanx.guest.r42.github-first-pr-readonly.v1',
    priorTreeProofValid:preceding.treeProof?.valid===true,
    merge,githubWriteCalls:0,automaticMergeAllowed:false,
    customerGo:false,productionAuthorized:false};
}
export function r42MergeMarkdown(result){
  const x=result?.merge;
  if(result?.schema!=='osmanx.guest.r42.github-first-pr-readonly.v1'||
    x?.productionAuthorized!==false)
    throw Error('R42 invalid read-only report');
  return [
    '# Guest Intelligence — PR #47 main-drift audit',
    '',
    'Source: https://github.com/osmanosmanov6880-bot/osmanx-world/pull/47',
    'Current main SHA: '+(x.observedMainSha||'unknown'),
    'Exact first source SHA: '+x.pinnedHead,
    'Ahead of main: '+x.firstPrAheadCommits,
    'Behind main: '+x.firstPrBehindCommits,
    'GitHub mergeable: '+x.githubMergeableObserved,
    'Branch protection independently observed: '+x.branchProtectionReadable,
    '',
    '## Next steps — manual and review-only',
    '1. Independent reviewer inspects PR #47 and the R41 SHA-pinned code packet.',
    '2. If behind main, human maintainer must reconcile main changes with the source branch; redo all CI on new SHA.',
    '3. Confirm branch protection with an appropriately privileged GitHub administrator; API 403 is NOT a verified policy.',
    '4. Obtain independent approval on current reviewed head and merge in dependency order.',
    '5. Verify fresh post-merge main CI, external staging, offsite DR, legal authority and change window.',
    '',
    ...x.blockers.map(s=>'- BLOCKED: '+s),
    '',
    '**NO-GO — neither approval nor merge was performed.**',
    ''
  ].join('\n');
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||!['--github','--markdown'].includes(process.argv[2]))
      throw Error('Use --github or --markdown');
    const report=await fetchR42MergeAudit();
    process.stdout.write(process.argv[2]==='--markdown'?
      r42MergeMarkdown(report):JSON.stringify(report)+'\n');
    if(report.merge.canHandOffToReviewer!==true||
      report.priorTreeProofValid!==true||
      report.githubWriteCalls!==0)process.exitCode=2;
  }catch{
    process.stderr.write('R42 first source GitHub audit NO-GO\n');
    process.exitCode=2;
  }
}
