/**
 * R40 line-by-line GitHub unified patch accounting. GitHub's files API may
 * silently truncate very large patches; each displayed hunk must close and
 * total +/- changes must match GitHub's recorded file counts.
 * This validates patch transport completeness, not correctness of code.
 */
export const R40_PATCH_SCHEMA='osmanx.guest.r40.unified-patch-completeness.v1';
const HEADER=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)?$/;
export function inspectR40UnifiedPatch(patch,{
  additions,deletions,maxBytes=131072
}={}){
  const errors=[];
  if(typeof patch!=='string'||patch.length<5||
    Buffer.byteLength(patch,'utf8')>maxBytes||
    !Number.isSafeInteger(additions)||additions<0||
    !Number.isSafeInteger(deletions)||deletions<0)
    return {schema:R40_PATCH_SCHEMA,valid:false,
      blockers:['MISSING_OR_OVERSIZED_PATCH'],hunks:0};
  let oldRemaining=0,newRemaining=0;
  let totalAdds=0,totalDeletes=0,hunks=0,lastOld=-1,lastNew=-1;
  const lines=patch.split('\n');
  if(lines.at(-1)==='')lines.pop();
  for(const line of lines){
    const header=HEADER.exec(line);
    if(header){
      if(hunks>0&&(oldRemaining!==0||newRemaining!==0))
        errors.push('INCOMPLETE_PRIOR_HUNK');
      const oldStart=Number(header[1]),newStart=Number(header[3]);
      const oldCount=header[2]===undefined?1:Number(header[2]);
      const newCount=header[4]===undefined?1:Number(header[4]);
      if(![oldStart,newStart,oldCount,newCount].every(Number.isSafeInteger)||
        oldStart<0||newStart<0||oldCount<0||newCount<0||
        oldStart<lastOld||newStart<lastNew)
        errors.push('INVALID_HUNK_COORDINATES');
      oldRemaining=oldCount;
      newRemaining=newCount;hunks++;
      lastOld=oldStart+oldCount;lastNew=newStart+newCount;
      continue;
    }
    if(!hunks){errors.push('NON_HUNK_PATCH_LINE');continue}
    if(line.startsWith('+')){
      newRemaining--;totalAdds++;
    }else if(line.startsWith('-')){
      oldRemaining--;totalDeletes++;
    }else if(line.startsWith(' ')){
      oldRemaining--;newRemaining--;
    }else if(line==='\\ No newline at end of file'){
      continue;
    }else{
      errors.push('INVALID_PATCH_LINE');
    }
    if(oldRemaining<0||newRemaining<0)
      errors.push('HUNK_OVERFLOW');
  }
  if(hunks===0||oldRemaining!==0||newRemaining!==0)
    errors.push('TRUNCATED_PATCH_HUNK');
  if(totalAdds!==additions||totalDeletes!==deletions)
    errors.push('GITHUB_PATCH_COUNTS_MISMATCH');
  return {schema:R40_PATCH_SCHEMA,valid:errors.length===0,
    blockers:[...new Set(errors)],hunks,
    additionsVerified:totalAdds,deletionsVerified:totalDeletes};
}
