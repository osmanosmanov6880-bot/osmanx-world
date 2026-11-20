/**
 * R45: parse the real local Git merge-tree --write-tree --name-only output.
 * This dry-run writes temporary Git objects only, never branch refs.
 * Even a conflict-free result is not an approval or permission to merge.
 */
import {createHash} from 'node:crypto';
import {R45_FIRST} from './guest-r45-compare-proof.mjs';
export const R45_MERGE_SCHEMA='osmanx.guest.r45.real-git-merge-preview.v1';
const SHA=/^[0-9a-f]{40}$/;
const PATH=/^[a-zA-Z0-9._@+ -]+(?:\/[a-zA-Z0-9._@+ -]+)*$/;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function assessR45MergeTree({
 mainSha,sourceSha=R45_FIRST.sha,exitCode,stdout
}={}){
 const blockers=[];
 if(!SHA.test(mainSha||'')||sourceSha!==R45_FIRST.sha)
   blockers.push('UNKNOWN_MAIN_OR_WRONG_SOURCE_SHA');
 if(exitCode!==0&&exitCode!==1)
   blockers.push('GIT_MERGE_TREE_COULD_NOT_COMPLETE');
 if(typeof stdout!=='string'||stdout.length>1024*1024||
   stdout.includes('\0'))blockers.push('MERGE_TREE_OUTPUT_MALFORMED');
 const lines=typeof stdout==='string'?
   stdout.replace(/\r\n/g,'\n').trimEnd().split('\n'):[];
 const treeSha=lines[0]||null;
 if(!SHA.test(treeSha))blockers.push('MERGE_TREE_RESULT_SHA_MISSING');
 const conflictPaths=(exitCode===1?lines.slice(1):[]).filter(Boolean);
 if(exitCode===0&&lines.length!==1)
   blockers.push('UNEXPECTED_CLEAN_MERGE_OUTPUT');
 if(exitCode===1&&conflictPaths.length===0)
   blockers.push('CONFLICT_EXIT_BUT_NO_CONFLICT_PATHS');
 if(conflictPaths.length>1000||
   conflictPaths.some(p=>!PATH.test(p)||p.startsWith('/')||
     p.split('/').some(segment=>segment===''||segment==='.'||segment==='..')))
   blockers.push('CONFLICT_PATHS_UNTRUSTED');
 if(new Set(conflictPaths).size!==conflictPaths.length)
   blockers.push('DUPLICATE_CONFLICT_PATHS');
 const valid=blockers.length===0;
 const report={schema:R45_MERGE_SCHEMA,valid,tool:'git merge-tree --write-tree --name-only --no-messages',
   mainSha:SHA.test(mainSha||'')?mainSha:null,
   sourcePr:47,sourceSha:R45_FIRST.sha,
   previewTreeSha:SHA.test(treeSha||'')?treeSha:null,
   mergeExitCode:exitCode,actualConflictCount:valid?conflictPaths.length:null,
   conflictPaths:valid?conflictPaths:[],
   conflictFreePreview:valid&&exitCode===0,
   branchRefsChanged:false,gitMergeCommandExecuted:false,
   // The test uses merge-tree, not git merge. It must never mutate main.
   humanReconcileRequired:!valid||exitCode===1,
   humanApprovalStillRequired:true,productionAuthorized:false,
   blockers};
 return {...report,sha256:hash(report)};
}
