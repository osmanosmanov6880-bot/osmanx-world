/**
 * R40 Ed25519 approval chronology: prevents valid signatures on impossible
 * timestamps, evidence created AFTER approval and misleading unsigned fields.
 * Pure checks; never produces GO or changes customer write state.
 */
const EXPECTED=['role','actorId','releaseCommit','evidenceDigest',
  'acceptedAt','expiresAt','signature'].sort();
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
export function canonicalR40Utc(value){
  if(typeof value!=='string'||!ISO.test(value))return false;
  const d=new Date(value);
  if(!Number.isFinite(d.getTime()))return false;
  const canonical=d.toISOString();
  return value===canonical||value===canonical.replace(/\.000Z$/,'Z');
}
export function validateR40ApprovalTimeline(record,{now=new Date()}={}){
  const blockers=[];
  const entries=record?.attestations;
  const evidence=record?.evidence;
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Array.isArray(entries)||entries.length!==2||
    !evidence||typeof evidence!=='object'||Array.isArray(evidence))
    return {valid:false,blockers:['UNTRUSTED_R40_TIMELINE'],
      productionAuthorized:false};
  let latestEvidence=-Infinity;
  for(const [name,item] of Object.entries(evidence)){
    if(!/^[A-Za-z][A-Za-z0-9]{1,70}$/.test(name)||
      !canonicalR40Utc(item?.observedAt)){
      blockers.push('NONCANONICAL_EVIDENCE_TIME');continue;
    }
    const at=Date.parse(item.observedAt);
    if(at>now.getTime())blockers.push('EVIDENCE_IN_FUTURE');
    latestEvidence=Math.max(latestEvidence,at);
  }
  for(const row of entries){
    const keys=row&&typeof row==='object'&&!Array.isArray(row)?
      Object.keys(row).sort():[];
    if(keys.join('|')!==EXPECTED.join('|'))
      blockers.push('UNSIGNED_OR_MISSING_ATTESTATION_FIELDS');
    if(!canonicalR40Utc(row?.acceptedAt)||
      !canonicalR40Utc(row?.expiresAt)){
      blockers.push('NONCANONICAL_APPROVAL_TIME');continue;
    }
    const at=Date.parse(row.acceptedAt),exp=Date.parse(row.expiresAt);
    if(latestEvidence>at)blockers.push('EVIDENCE_CREATED_AFTER_APPROVAL');
    if(exp<=at)blockers.push('APPROVAL_EXPIRES_BEFORE_ACCEPTANCE');
  }
  return {valid:blockers.length===0,blockers:[...new Set(blockers)],
    independentHumanReviewPerformed:false,
    productionAuthorized:false};
}
