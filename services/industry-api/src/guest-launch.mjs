// R12: deterministic two-human pilot launch preflight, no AI, no customer PII.
import {createHash} from 'node:crypto';
export const SCHEMA='osmanx.guest.launch.gate.v1';
export const EVIDENCE_SCHEMA='osmanx.guest.launch.snapshot.v1';
const LABELS={
  enrolled:'Владелец должен включить необратимую проверку запуска R12.',
  draft:'Пилот должен находиться в стадии черновика.',
  protocol:'Перед запуском нужен зафиксированный протокол исследования.',
  prospective:'Протокол должен быть зарегистрирован до начала первого периода.',
  measurementWindow:'Период измерения уже закончился. Требуется новый пилот с актуальным протоколом.',
  sixReadiness:'Подтвердите все шесть действующих условий запуска.',
  ownerPresent:'В компании должен быть действующий владелец.',
  managerPresent:'Нужен отдельный действующий управляющий.',
  ownerSigned:'Владелец должен подтвердить актуальные условия в последние 14 дней.',
  managerSigned:'Управляющий должен независимо подтвердить те же условия в последние 14 дней.',
  independent:'Подтверждения должны принадлежать разным действующим сотрудникам.'
};
const REQUIRED=['repeatDefinition','sameWindow','independentGroups',
  'marginVerified','contactConsent','ownerAgreed'];
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function snapshotLaunch(pilot){
  if(!pilot||typeof pilot.id!=='string')throw new TypeError('Invalid pilot');
  const time=pilot.protocol_registered_at;
  return {
    schema:EVIDENCE_SCHEMA,
    pilotId:pilot.id,pilotVersion:pilot.version,
    protocol:pilot.protocol||null,
    protocolRegisteredAt:time?(time instanceof Date?time.toISOString():new Date(time).toISOString()):null,
    targetPerGroup:Number(pilot.target_per_group),
    readiness:Object.fromEntries(REQUIRED.map(k=>[k,pilot.readiness?.[k]===true]))
  };
}
export function launchPreflight({pilot,members=[],attestations=[],now=new Date()}){
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Array.isArray(members)||!Array.isArray(attestations))
    throw new TypeError('Invalid launch input');
  const snapshot=snapshotLaunch(pilot),snapshotDigest=sha(snapshot);
  const people=members.filter(m=>m&&['owner','manager'].includes(m.role)&&
    typeof m.account_id==='string'&&m.active!==false);
  const owners=new Set(people.filter(m=>m.role==='owner').map(m=>m.account_id));
  const managers=new Set(people.filter(m=>m.role==='manager').map(m=>m.account_id));
  const activeRole=(role)=>role==='owner'?owners:managers;
  const signed={owner:null,manager:null};
  // DB returns latest role event first. A signoff from a revoked, disabled, demoted,
  // expired or different-snapshot member never counts.
  for(const item of attestations){
    if(!item||!['owner','manager'].includes(item.role)||signed[item.role])continue;
    if(!activeRole(item.role).has(item.actor_id))continue;
    signed[item.role]={
      role:item.role,actorId:item.actor_id,
      acceptedAt:new Date(item.accepted_at).toISOString(),
      expiresAt:new Date(item.expires_at).toISOString(),
      current:item.snapshot_digest===snapshotDigest&&
        new Date(item.expires_at)>now&&new Date(item.accepted_at)<=now
    };
  }
  const p=pilot.protocol,registration=p?Date.parse(snapshot.protocolRegisteredAt):NaN,
    start=p?Date.parse(p.startDate+'T00:00:00.000Z'):NaN;
  const checks={
    enrolled:!!pilot.launch_gate_enrolled_at,
    draft:pilot.phase==='draft',
    protocol:!!p&&Number.isFinite(start),
    prospective:!!p&&Number.isFinite(registration)&&Number.isFinite(start)&&registration<=start,
    measurementWindow:!!p&&typeof p.endDate==='string'&&p.endDate>=now.toISOString().slice(0,10),
    sixReadiness:REQUIRED.every(k=>pilot.readiness?.[k]===true),
    ownerPresent:owners.size>0,
    managerPresent:managers.size>0,
    ownerSigned:!!signed.owner?.current,
    managerSigned:!!signed.manager?.current,
    independent:!!signed.owner?.current&&!!signed.manager?.current&&
      signed.owner.actorId!==signed.manager.actorId
  };
  const blockers=Object.entries(checks).filter(([,ok])=>!ok)
    .map(([code])=>({code,reason:LABELS[code]}));
  return {
    schema:SCHEMA,pilotId:pilot.id,phase:pilot.phase,version:pilot.version,
    enrolled:checks.enrolled,snapshotDigest,expiresAfterDays:14,
    checks,blockers,attestations:signed,
    canStartIsolatedPilot:blockers.length===0,
    customerProductionAuthorized:false,
    disclaimer:'Подтверждение сотрудников не является электронной подписью, договором или разрешением на production. Для живых клиентов нужен отдельно развёрнутый API, законные основания обработки данных и операторский допуск.'
  };
}
