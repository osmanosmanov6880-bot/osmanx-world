/**
 * R18 external-custodian receipt fence. Must be invoked INSIDE the same
 * PostgreSQL transaction as R17 fence and protected Guest mutation.
 * Never creates approvals and never alters GUEST_WRITES_ENABLED.
 */
const SHA=/^[a-f0-9]{64}$/;
function closed(){
  const error=new Error('R18: внешний якорь или контроль восстановления недоступен');
  error.statusCode=503;
  return error;
}
export async function assertR18Fence(db,receipt){
  const revision=receipt?.revision,sequence=receipt?.sequence,
    anchor=receipt?.anchorDigest,checkpoint=receipt?.checkpointDigest;
  if(!Number.isSafeInteger(revision)||revision<1||
     !Number.isSafeInteger(sequence)||sequence<1||
     !SHA.test(anchor||'')||!SHA.test(checkpoint||'')||
     receipt.receiptVerified!==true)throw closed();
  try{
    const result=await db.query(
      'SELECT max_revision,max_sequence,checkpoint_sha,anchor_sha FROM industry.guest_external_anchor_fence WHERE id=1 FOR UPDATE'
    );
    if(result.rowCount!==1)throw closed();
    const row=result.rows[0],oldRevision=Number(row.max_revision),
      oldSequence=Number(row.max_sequence);
    if(!Number.isSafeInteger(oldRevision)||!Number.isSafeInteger(oldSequence)||
       revision<oldRevision||sequence<oldSequence||
       (sequence===oldSequence&&(row.checkpoint_sha!==checkpoint||
         row.anchor_sha!==anchor||revision!==oldRevision)))
      throw closed();
    if(sequence>oldSequence){
      const written=await db.query(
        'UPDATE industry.guest_external_anchor_fence SET max_revision=$1,max_sequence=$2,checkpoint_sha=$3,anchor_sha=$4,updated_at=now() WHERE id=1 AND max_revision<=$1 AND max_sequence<$2',
        [revision,sequence,checkpoint,anchor]
      );
      if(written.rowCount!==1)throw closed();
      const inserted=await db.query(
        'INSERT INTO industry.guest_external_anchor_receipts(journal_sequence,registry_revision,checkpoint_sha,anchor_sha) VALUES($1,$2,$3,$4)',
        [sequence,revision,checkpoint,anchor]
      );
      if(inserted.rowCount!==1)throw closed();
    }else if(sequence!==0){
      const match=await db.query(
        'SELECT 1 FROM industry.guest_external_anchor_receipts WHERE journal_sequence=$1 AND registry_revision=$2 AND checkpoint_sha=$3 AND anchor_sha=$4',
        [sequence,revision,checkpoint,anchor]
      );
      if(match.rowCount!==1)throw closed();
    }
    return {sequence,revision,matched:true};
  }catch{throw closed();}
}
export async function inspectR18Fence(db,receipt){
  try{
    const r=await db.query(
      'SELECT max_revision,max_sequence,checkpoint_sha,anchor_sha FROM industry.guest_external_anchor_fence WHERE id=1'
    );
    const row=r.rows[0],revision=Number(row?.max_revision),
      sequence=Number(row?.max_sequence);
    if(r.rowCount!==1||!Number.isSafeInteger(revision)||
       !Number.isSafeInteger(sequence)||receipt?.receiptVerified!==true)
      throw Error('Bad fence');
    let valid=revision<=receipt.revision&&sequence<=receipt.sequence;
    if(sequence===receipt.sequence)
      valid=valid&&revision===receipt.revision&&
        row.anchor_sha===receipt.anchorDigest&&
        row.checkpoint_sha===receipt.checkpointDigest;
    const log=await db.query(
      'SELECT count(*)::int AS total FROM industry.guest_external_anchor_receipts WHERE journal_sequence<=$1',
      [sequence]
    );
    if(sequence>0&&Number(log.rows[0]?.total)<1)valid=false;
    return {fenceReady:valid,revisionFloor:revision,sequenceFloor:sequence,
      receiptRows:Number(log.rows[0]?.total??0)};
  }catch{return {fenceReady:false,revisionFloor:null,sequenceFloor:null,receiptRows:null};}
}
