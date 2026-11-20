/**
 * R41 verify that the complete read-only GitHub PR file inventory refers to
 * the exact Git object blobs under the pinned head Git tree. A syntactically
 * complete diff alone is not enough.
 */
export const R41_TREE_SCHEMA='osmanx.guest.r41.pr47-exact-git-tree.v1';
const HEAD='840bb083e606058a9a32450f3b3a3e881a34891e';
const SHA=/^[a-f0-9]{40}$/;
export function verifyR41FirstPrTree({
  pr,commit,files,tree,filesComplete=false
}={}){
  const blockers=[];
  if(pr?.number!==47||pr?.head?.sha!==HEAD||
    pr?.state!=='open'||pr?.merged===true)
    blockers.push('PINNED_FIRST_PR_HEAD_CHANGED');
  if(commit?.sha!==HEAD||!SHA.test(commit?.tree?.sha||'')||
    tree?.sha!==commit?.tree?.sha||tree?.truncated!==false||
    !Array.isArray(tree?.tree)||tree.tree.length>100000)
    blockers.push('INCOMPLETE_OR_WRONG_GIT_TREE');
  if(!filesComplete||!Array.isArray(files)||
    files.length!==10||pr?.changed_files!==10)
    blockers.push('INCOMPLETE_CHANGED_FILE_INVENTORY');
  const map=new Map(),duplicates=new Set();
  for(const item of Array.isArray(tree?.tree)?tree.tree:[]){
    if(!item||typeof item.path!=='string')continue;
    if(map.has(item.path))duplicates.add(item.path);
    map.set(item.path,item);
  }
  if(duplicates.size)blockers.push('DUPLICATED_TREE_PATHS');
  let verified=0;
  const seen=new Set();
  for(const f of Array.isArray(files)?files:[]){
    if(!f||typeof f.filename!=='string'||seen.has(f.filename)||
      !SHA.test(f.sha||'')||
      !['added','modified','removed'].includes(f.status)){
      blockers.push('UNEXPECTED_PR_FILE_METADATA');continue;
    }
    seen.add(f.filename);
    const blob=map.get(f.filename);
    if(f.status==='removed'){
      if(blob)blockers.push('REMOVED_FILE_STILL_IN_TREE');
      else verified++;
    }else if(blob?.type==='blob'&&blob.sha===f.sha){
      verified++;
    }else blockers.push('DIFF_FILE_BLOB_NOT_EQUAL_PINNED_TREE');
  }
  if(verified!==10)blockers.push('NOT_ALL_TEN_BLOBS_VERIFIED');
  return {schema:R41_TREE_SCHEMA,valid:blockers.length===0,
    exactHead:HEAD,
    treeSha:SHA.test(commit?.tree?.sha||'')?commit.tree.sha:null,
    verifiedFiles:verified,requiredFiles:10,
    githubRequestsReadOnly:true,githubWriteCalls:0,
    humanCodeReviewCompleted:false,
    productionAuthorized:false,blockers:[...new Set(blockers)]};
}
