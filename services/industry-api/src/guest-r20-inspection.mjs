/**
 * R20 strictly read-only one-pilot control tower: SQL aggregates only.
 * Not a legal/commercial approval engine, not a toggle, never writes.
 */
import {protocolDigest} from './guest-r19-scope.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
export const R20_STATUS_SCHEMA='osmanx.guest.r20.pilot-inspection.v1';
export async function inspectR20Pilot(db,{
  tenantId,pilot,hold=null,permit=null,witness=null,anchor=null,scope=null,
  now=new Date()
}={}){
  if(!UUID.test(tenantId||'')||!UUID.test(pilot?.id||'')||
     !(now instanceof Date)||!Number.isFinite(now.getTime()))
    throw new TypeError('R20 invalid inspection inputs');
  const checks={
    registeredProtocol:false,launchEnrolled:false,
    noSafetyHold:hold?.active!==true,
    r16TenantPermit:permit?.permitValid===true,
    r17SignedCheckpoint:witness?.checkpointDigest&&SHA.test(witness.checkpointDigest),
    r18ExternalReceipt:anchor?.receiptVerified===true,
    r19ScopeExact:false,scopeInDate:false,
    withinDailyBudget:false,dailyAuditMatchesQuota:false,
    retentionWindowCurrent:false,releaseChainVerified:false,
    externalDrAttested:false,legalEvidenceReviewed:false
  };
  let digest=null;
  try{digest=protocolDigest(pilot);checks.registeredProtocol=SHA.test(digest);}
  catch{/* Historical unsigned protocol: NO-GO */ }
  checks.launchEnrolled=!!pilot.launch_gate_enrolled_at;
  checks.r19ScopeExact=scope?.valid===true&&scope?.tenantId===tenantId&&
    scope?.pilotId===pilot.id&&scope?.record?.protocolDigest===digest&&
    scope?.record?.checkpointDigest===anchor?.checkpointDigest&&
    scope?.record?.journalSequence===witness?.sequence;
  const end=Date.parse(scope?.expiresAt||'');
  checks.scopeInDate=Number.isFinite(end)&&now.getTime()<end;
  const protocolEnd=Date.parse(pilot?.protocol?.endDate+'T00:00:00.000Z');
  const retention=scope?.record?.policy?.retentionDays;
  checks.retentionWindowCurrent=Number.isFinite(protocolEnd)&&
    Number.isSafeInteger(retention)&&retention>=1&&retention<=90&&
    now.getTime()<=protocolEnd+retention*86400000;
  let daily={used:null,max:null,remaining:null,auditEvents:null};
  try{
    const usage=await db.query(
      "SELECT used_count,max_daily FROM industry.guest_r19_daily_usage"+
      " WHERE tenant_id=$1 AND pilot_id=$2 AND utc_day=(now() AT TIME ZONE 'UTC')::date",
      [tenantId,pilot.id]);
    const events=await db.query(
      "SELECT count(*)::int AS n FROM industry.guest_r19_collection_events"+
      " WHERE tenant_id=$1 AND pilot_id=$2 AND utc_day=(now() AT TIME ZONE 'UTC')::date",
      [tenantId,pilot.id]);
    const recorded=Number(usage.rows[0]?.used_count??0);
    const limit=Math.min(Number(usage.rows[0]?.max_daily??scope?.maxDailyWrites),
      Number(scope?.maxDailyWrites));
    const audit=Number(events.rows[0]?.n);
    if(Number.isSafeInteger(recorded)&&recorded>=0&&
       Number.isSafeInteger(limit)&&limit>=1&&limit<=100&&
       Number.isSafeInteger(audit)&&audit>=0){
      daily={used:recorded,max:limit,remaining:Math.max(0,limit-recorded),
        auditEvents:audit};
      checks.withinDailyBudget=recorded<limit;
      checks.dailyAuditMatchesQuota=recorded===audit;
    }
  }catch{/* Missing R19 schema or privileges: fail closed. */}
  const checksMandatory=[
    'registeredProtocol','launchEnrolled','noSafetyHold',
    'r16TenantPermit','r17SignedCheckpoint','r18ExternalReceipt',
    'r19ScopeExact','scopeInDate','withinDailyBudget',
    'dailyAuditMatchesQuota','retentionWindowCurrent'
  ];
  const technicalBlockers=checksMandatory.filter(k=>checks[k]!==true);
  return {schema:R20_STATUS_SCHEMA,pilotId:pilot.id,phase:pilot.phase,
    protocolDigest:digest,checks,daily,
    technicalReviewPossible:technicalBlockers.length===0,
    technicalBlockers,
    externalBlockers:[
      'release_chain_independent_review_required',
      'encrypted_offsite_dr_proof_required',
      'legal_consent_contract_review_required'
    ],
    documentsVerifiedByLegal:false,legalGo:false,customerGo:false,
    productionAuthorized:false,changedProduction:false,
    disclaimer:'Техническая проверка не разрешает работу с реальными клиентами.'};
}
