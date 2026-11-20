/**
 * R14 deterministic incident state machine for external, sanitized monitor
 * samples. A status report never triggers a restart or alters customer records.
 */
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';

export function advanceIncident(state,sample,{failureThreshold=3,recoveryThreshold=2}={}){
  if(!Number.isInteger(failureThreshold)||failureThreshold<1||
     !Number.isInteger(recoveryThreshold)||recoveryThreshold<1)
    throw new TypeError('Invalid thresholds');
  if(!sample||!['healthy','degraded','down'].includes(sample.status))
    throw new TypeError('Invalid monitor sample');
  const previous=state&&typeof state==='object'?state:{phase:'normal',failures:0,recoveries:0};
  if(!['normal','incident'].includes(previous.phase)||
     !Number.isSafeInteger(previous.failures)||previous.failures<0||
     !Number.isSafeInteger(previous.recoveries)||previous.recoveries<0)
    throw new TypeError('Invalid incident state');
  const healthy=sample.status==='healthy';
  const failures=healthy?0:previous.failures+1;
  const recoveries=healthy?previous.recoveries+1:0;
  let phase=previous.phase,event='none';
  if(phase==='normal'&&failures>=failureThreshold){phase='incident';event='opened';}
  if(phase==='incident'&&recoveries>=recoveryThreshold){phase='normal';event='resolved';}
  return {schema:'osmanx.guest.r14.incident.v1',phase,event,failures,recoveries,
    severity:phase==='incident'?(sample.status==='down'?'critical':'warning'):'none',
    nextAction:event==='opened'?
      'Freeze customer onboarding, inspect R13 hold state and preserve audit/DR evidence':
      event==='resolved'?'Run authenticated two-person review before further onboarding':
      'Observe the next scheduled check; never auto-enable writes or clear safety holds'};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  if(process.argv.length!==4)throw Error('Usage: node scripts/r14-incident.mjs state.json sample.json');
  const [state,sample]=await Promise.all(process.argv.slice(2).map(async path=>
    JSON.parse(await readFile(path,'utf8'))));
  process.stdout.write(JSON.stringify(advanceIncident(state,sample))+'\n');
}
