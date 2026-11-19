/**
 * R29 rollback rehearsal: human-reviewed bounded transitions only.
 * Neither this function nor the API executes rollback, deploy or DB writes.
 */
export const R29_ROLLBACK_SCHEMA='osmanx.guest.r29.rollback-safety.v1';
const STATES=Object.freeze(['STAGED','STOPPED','ROLLBACK_DRY_RUN',
  'RECOVERED_OFFLINE','INDEPENDENT_REVIEW','CLOSED']);
const ALLOWED=Object.freeze({
  STAGED:['STOPPED'],STOPPED:['ROLLBACK_DRY_RUN'],
  ROLLBACK_DRY_RUN:['RECOVERED_OFFLINE'],
  RECOVERED_OFFLINE:['INDEPENDENT_REVIEW'],
  INDEPENDENT_REVIEW:['CLOSED'],CLOSED:[]
});
const SHA=/^[a-f0-9]{64}$/;
export function evaluateR29Rollback({steps=[],expectedReleaseSha,
  expectedRestoreSha}={}){
  if(!SHA.test(expectedReleaseSha||'')||
     !SHA.test(expectedRestoreSha||'')||
     !Array.isArray(steps)||steps.length>5)
    throw new TypeError('Expected pinned release and restore digests required');
  let state='STAGED';const events=[],blockers=[];
  for(const [index,e] of steps.entries()){
    if(!e||typeof e!=='object'||Array.isArray(e)||
       Object.keys(e).sort().join('|')!==
       ['stage','releaseSha','restoreSha','operatorRole'].sort().join('|')||
       !STATES.includes(e.stage)||
       !['owner','manager','recovery','auditor'].includes(e.operatorRole)||
       e.releaseSha!==expectedReleaseSha||
       e.restoreSha!==expectedRestoreSha){
      blockers.push('INVALID_ROLLBACK_EVIDENCE_'+(index+1));break;
    }
    if(!ALLOWED[state].includes(e.stage)){
      blockers.push('ILLEGAL_STATE_TRANSITION_'+(index+1));break;
    }
    const requiredRole={
      STOPPED:'owner',ROLLBACK_DRY_RUN:'manager',
      RECOVERED_OFFLINE:'recovery',
      INDEPENDENT_REVIEW:'auditor',CLOSED:'owner'
    };
    if(e.operatorRole!==requiredRole[e.stage]){
      blockers.push('INSUFFICIENT_OPERATOR_SEPARATION_'+(index+1));break;
    }
    events.push({from:state,to:e.stage,performedOfflineBy:e.operatorRole});
    state=e.stage;
  }
  if(state!=='CLOSED')blockers.push('ROLLBACK_REHEARSAL_NOT_COMPLETE');
  if(!steps.length)blockers.push('NO_OPERATOR_REHEARSAL_EVIDENCE');
  return {
    schema:R29_ROLLBACK_SCHEMA,stage:state,validatedEvents:events,
    expectedSteps:5,completedSteps:events.length,
    syntheticPathComplete:blockers.length===0,
    blockers:[...new Set(blockers)],
    remoteRollbackExecuted:false,productionStopped:false,
    physicalRestoreAttested:false,approvalToResume:false,
    productionAuthorized:false,customerGo:false,
    disclaimer:'Проверка последовательности отдельно подписанных этапов; не запускает настоящий rollback и не подтверждает восстановление на VPS.'
  };
}
export const R29_ROLLBACK_ORDER=Object.freeze(
  ['STOPPED','ROLLBACK_DRY_RUN','RECOVERED_OFFLINE',
   'INDEPENDENT_REVIEW','CLOSED']);
