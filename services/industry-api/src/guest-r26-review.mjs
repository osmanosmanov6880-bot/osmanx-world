/**
 * R26 two-person INTERNAL source declarations only.
 * A DB identity/role and a SHA256 of a separate redacted workpaper are NOT
 * an independent audit, signature, proof of underlying accuracy or legal GO.
 */
export const R26_REVIEW_SCHEMA='osmanx.guest.r26.source-review-gate.v1';
export const R26_METHODS=Object.freeze([
  'staff_shift_crosscheck','anonymous_counter_audit',
  'independent_aggregate_recount'
]);
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const same=(a,b)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
export function parseR26ReviewRequest(body){
  const keys=['expectedVersion','sourceSha','r24EvidenceSha',
    'evidenceSha','method','verdict'];
  if(!body||typeof body!=='object'||Array.isArray(body)||
     Object.keys(body).sort().join('|')!==keys.sort().join('|')||
     !Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1||
     !SHA.test(body.sourceSha||'')||
     !SHA.test(body.r24EvidenceSha||'')||
     !SHA.test(body.evidenceSha||'')||
     body.evidenceSha===body.sourceSha||
     body.evidenceSha===body.r24EvidenceSha||
     !R26_METHODS.includes(body.method)||
     !['reconciled','rejected'].includes(body.verdict))
    throw new TypeError('R26 exact bounded review declaration required');
  return Object.fromEntries(keys.map(k=>[k,body[k]]));
}
export function evaluateR26ReviewGate({
  pilotId,pilotVersion,sourceSha,r24EvidenceSha,tallyRows,
  reviews=[],stopActive=false
}={}){
  if(!UUID.test(pilotId||'')||!Number.isSafeInteger(pilotVersion)||
     pilotVersion<1||!SHA.test(sourceSha||'')||
     !SHA.test(r24EvidenceSha||'')||
     !Number.isSafeInteger(tallyRows)||tallyRows<0||tallyRows>36||
     !Array.isArray(reviews)||reviews.length>100)
    throw new TypeError('R26 bounded review inputs required');
  const current=[],historical=[];
  for(const r of reviews){
    if(!UUID.test(r?.actorId||'')||
      !Number.isSafeInteger(r.pilotVersion)||r.pilotVersion<1||
      !SHA.test(r.sourceSha||'')||!SHA.test(r.r24EvidenceSha||'')||
      !SHA.test(r.evidenceSha||'')||
      !['owner','manager'].includes(r.role)||
      !R26_METHODS.includes(r.method)||
      !['reconciled','rejected'].includes(r.verdict)||
      !Number.isSafeInteger(r.tallyRows)||r.tallyRows<1||
      r.tallyRows>36)
      throw new TypeError('R26 persisted review has invalid immutable fields');
    const matched=r.pilotVersion===pilotVersion&&
      same(r.sourceSha,sourceSha)&&same(r.r24EvidenceSha,r24EvidenceSha)&&
      r.tallyRows===tallyRows;
    (matched?current:historical).push(r);
  }
  const owner=current.filter(x=>x.role==='owner');
  const manager=current.filter(x=>x.role==='manager');
  const blockers=[];
  if(tallyRows===0)blockers.push('NO_SIGNALS_TO_AUDIT');
  if(stopActive)blockers.push('EMERGENCY_STOP_ACTIVE');
  if(owner.length!==1)blockers.push('OWNER_REVIEW_MISSING_OR_DUPLICATE');
  if(manager.length!==1)blockers.push('MANAGER_REVIEW_MISSING_OR_DUPLICATE');
  if(current.some(r=>r.verdict==='rejected'))
    blockers.push('INTERNAL_REVIEW_REJECTED');
  const two=owner.length===1&&manager.length===1;
  if(two&&owner[0].actorId===manager[0].actorId)
    blockers.push('REVIEW_ACTORS_NOT_SEPARATE');
  if(two&&owner[0].evidenceSha===manager[0].evidenceSha)
    blockers.push('REVIEW_WORKPAPERS_NOT_DISTINCT');
  const internalDeclarationsComplete=blockers.length===0;
  return {
    schema:R26_REVIEW_SCHEMA,
    current:{owner:owner.length===1?{
      present:true,verdict:owner[0].verdict,method:owner[0].method
    }:{present:false,verdict:null,method:null},
    manager:manager.length===1?{
      present:true,verdict:manager[0].verdict,method:manager[0].method
    }:{present:false,verdict:null,method:null}},
    currentReviewCount:current.length,historicalReviewCount:historical.length,
    internalDeclarationsComplete,blockers,
    sourceHashMatchesCurrent:current.length>0,
    reviewedPrimaryEvidenceExternally:false,
    reviewerCryptographicSignatures:false,
    customerMotivesVerified:false,customerGo:false,
    productionAuthorized:false,changedProduction:false
  };
}
