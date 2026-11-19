/**
 * R17 transaction-scoped durable monotonic fence. It must run in the SAME
 * PostgreSQL transaction as Guest mutation, after session and membership.
 * It cannot be bypassed by restarting Node or replaying an older registry file.
 */
const SHA=/^[a-f0-9]{64}$/;
function fail(){
  const error=new Error('R17: подтверждённая версия реестра устарела или недоступна');
  error.statusCode=503;
  return error;
}
export async function assertR17Fence(db,bundle){
  const p=bundle?.checkpoint,sha=bundle?.checkpointDigest;
  if(!Number.isSafeInteger(p?.sequence)||p.sequence<1||
     !Number.isSafeInteger(p?.revision)||p.revision<1||!SHA.test(sha||''))
    throw fail();
  try{
    const result=await db.query(
      'SELECT max_revision,max_sequence,checkpoint_sha FROM industry.guest_registry_checkpoint_fence WHERE id=1 FOR UPDATE'
    );
    if(result.rowCount!==1)throw fail();
    const row=result.rows[0],beforeRevision=Number(row.max_revision),
      beforeSequence=Number(row.max_sequence);
    if(!Number.isSafeInteger(beforeRevision)||!Number.isSafeInteger(beforeSequence)||
      p.revision<beforeRevision||p.sequence<beforeSequence||
      (p.sequence===beforeSequence && row.checkpoint_sha!==sha))
      throw fail();
    if(p.sequence>beforeSequence){
      const changed=await db.query(
        'UPDATE industry.guest_registry_checkpoint_fence SET max_revision=$1,max_sequence=$2,checkpoint_sha=$3,updated_at=now() WHERE id=1 AND max_revision<=$1 AND max_sequence<$2',
        [p.revision,p.sequence,sha]
      );
      if(changed.rowCount!==1)throw fail();
    }
    return {sequence:p.sequence,revision:p.revision,matched:true};
  }catch{
    // No SQL, server, credential or tenant details are returned to the caller.
    throw fail();
  }
}
export async function inspectR17Fence(db,checkpoint){
  try{
    const r=await db.query(
      'SELECT max_revision,max_sequence,checkpoint_sha FROM industry.guest_registry_checkpoint_fence WHERE id=1'
    );
    const p=checkpoint?.checkpoint;
    const old=r.rows[0];
    const revision=Number(old?.max_revision),sequence=Number(old?.max_sequence);
    const allowed=r.rowCount===1&&Number.isSafeInteger(revision)&&
      Number.isSafeInteger(sequence)&&p&&
      revision<=p.revision&&sequence<=p.sequence&&
      (sequence!==p.sequence||old.checkpoint_sha===checkpoint.checkpointDigest);
    return {fenceReady:allowed===true,
      // A checkpoint can be ahead of DB: only an authenticated Guest mutation
      // should advance the DB fence, NEVER this read-only endpoint.
      floorRevision:Number.isSafeInteger(revision)?revision:null,
      floorSequence:Number.isSafeInteger(sequence)?sequence:null};
  }catch{return {fenceReady:false,floorRevision:null,floorSequence:null};}
}
