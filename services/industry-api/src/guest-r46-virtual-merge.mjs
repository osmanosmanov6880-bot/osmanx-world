/**
 * R46: validate a 32-stage read-only VIRTUAL merger computed with Git
 * merge-tree + commit-tree in an ephemeral runner. commit-tree writes
 * unreachable Git objects, NOT refs; no git merge, rebase, push or deploy.
 */
import {createHash} from 'node:crypto';
import {R46_PINNED_STACK} from './guest-r46-source-graph.mjs';
export const R46_VIRTUAL_SCHEMA='osmanx.guest.r46.disposable-32-stage-virtual-merge.v1';
const SHA=/^[a-f0-9]{40}$/;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const validPath=p=>typeof p==='string'&&p.length>0&&p.length<=1024&&
 !p.startsWith('/')&&!p.includes('\\')&&!/[\x00-\x1f\x7f\ufffd]/.test(p)&&
 p.split('/').every(x=>x!==''&&x!=='.'&&x!=='..');

export function assessR46VirtualMerge({
 mainSha,steps=[],branchRefsBefore,branchRefsAfter
}={}){
 const blockers=[];
 if(!SHA.test(mainSha||''))blockers.push('UNPINNED_MAIN');
 if(!SHA.test(branchRefsBefore||'')||branchRefsAfter!==branchRefsBefore)
   blockers.push('BRANCH_REF_SNAPSHOT_DRIFT');
 if(!Array.isArray(steps)||steps.length<1||
   steps.length>R46_PINNED_STACK.length)
   blockers.push('INVALID_VIRTUAL_STEP_COUNT');
 let previous=mainSha,hasConflict=false;
 for(const [i,s] of (Array.isArray(steps)?steps:[]).entries()){
   const expected=R46_PINNED_STACK[i];
   if(!expected||s?.number!==expected.number||
     s?.sourceSha!==expected.sha||s?.baseBefore!==previous)
     blockers.push('VIRTUAL_SOURCE_OR_PARENT_ORDER_MISMATCH');
   if(!SHA.test(s?.treeSha||'')||![0,1].includes(s?.mergeExitCode))
     blockers.push('UNTRUSTED_MERGE_TREE_RESULT');
   const paths=s?.conflictPaths;
   if(!Array.isArray(paths)||paths.length>1000||
     !paths.every(validPath)||new Set(paths).size!==paths.length)
     blockers.push('UNTRUSTED_CONFLICT_PATH_LIST');
   if(s?.mergeExitCode===0){
     if(paths?.length!==0||!SHA.test(s?.syntheticCommit||''))
       blockers.push('CLEAN_MERGE_COMMIT_MISSING');
     previous=s?.syntheticCommit;
   }else if(s?.mergeExitCode===1){
     hasConflict=true;
     if(s?.syntheticCommit!==null||!paths?.length||
       i!==steps.length-1)
       blockers.push('CONFLICT_MUST_STOP_BEFORE_NEXT_PR');
   }
   if(hasConflict&&i<steps.length-1)
     blockers.push('STEPS_EXECUTED_AFTER_FIRST_CONFLICT');
 }
 if(!hasConflict&&steps.length!==R46_PINNED_STACK.length)
   blockers.push('VIRTUAL_MERGE_INCOMPLETE_WITHOUT_CONFLICT');
 const valid=blockers.length===0;
 const summarized=(Array.isArray(steps)?steps:[]).map(s=>({
   number:s.number,sourceSha:s.sourceSha,
   treeSha:s.treeSha,mergeExitCode:s.mergeExitCode,
   conflictPaths:s.conflictPaths,
   virtualCommitSha:s.syntheticCommit
 }));
 const r={schema:R46_VIRTUAL_SCHEMA,valid,mainSha:SHA.test(mainSha||'')?mainSha:null,
   requestedSourcePrs:32,
   evaluatedPrs:summarized.length,
   successfullyRehearsed:summarized.filter(s=>s.mergeExitCode===0).length,
   firstBlockedPr:hasConflict?summarized.at(-1)?.number:null,
   firstBlockedPaths:hasConflict?summarized.at(-1)?.conflictPaths:[],
   completeWithoutGitConflicts:valid&&!hasConflict&&summarized.length===32,
   ephemeralGitObjectsOnly:true,githubWrites:0,
   branchRefsModified:branchRefsBefore!==branchRefsAfter,
   actualGitBranchMergesExecuted:0,
   humanReviewAndFreshCIStillRequired:true,
   productionAuthorized:false,customerGo:false,
   steps:summarized,blockers:[...new Set(blockers)]};
 return {...r,sha256:hash(r)};
}
