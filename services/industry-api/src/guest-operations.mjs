import {createHash} from 'node:crypto';

export const OPS_SCHEMA='osmanx.guest.operations.v1';
export const BUNDLE_SCHEMA='osmanx.guest.operations.export.v1';
const ADVISORY={
  OVERDUE_ACTIONS:'Переназначьте или выполните просроченные действия с указанием ответственного.',
  WINDOW_ENDED:'Окно наблюдения завершилось. Проверьте полноту данных и подготовьте независимую проверку.',
  NO_OBSERVATIONS:'Пилот идёт без агрегированных наблюдений. Проверьте наличие разрешённого источника.',
  REVIEW_STALLED:'Независимый разбор ожидает действия управляющего более семи дней.',
  RETURN_STALLED:'Возвращённый на доработку пилот остаётся без обновления более семи дней.'
};
function validDate(value){const t=Date.parse(value);return Number.isFinite(t)?t:NaN}
function daysSince(value,now){const n=validDate(value);return Number.isFinite(n)?Math.max(0,(now.getTime()-n)/86400000):0}
export function riskForPilot(pilot,{now=new Date()}={}){
  const signals=[];
  const add=(code,severity,reason)=>signals.push({code,severity,reason,nextStep:ADVISORY[code]});
  const overdue=Number(pilot.overdue_actions)||0;
  const count=Number(pilot.period_count)||0;
  if(overdue>0)add('OVERDUE_ACTIONS','high',overdue+' действий с истекшим сроком.');
  const protocol=pilot.protocol;
  if(pilot.phase==='running'&&protocol?.endDate&&
      Number.isInteger(protocol.outcomeWindowDays)&&
      now.getTime()>Date.parse(protocol.endDate+'T00:00:00Z')+
        (protocol.outcomeWindowDays+1)*86400000)
    add('WINDOW_ENDED','high','Завершилось установленное окно повторных визитов.');
  if(pilot.phase==='running'&&count===0&&daysSince(pilot.updated_at,now)>=3)
    add('NO_OBSERVATIONS','medium','После последнего изменения пилота прошло не менее трёх дней.');
  if(pilot.phase==='in_review'&&daysSince(pilot.updated_at,now)>=7)
    add('REVIEW_STALLED','high','Владелец ждёт независимого решения более семи дней.');
  if(pilot.phase==='returned'&&daysSince(pilot.updated_at,now)>=7)
    add('RETURN_STALLED','medium','Возвращённый пилот не обновлялся более семи дней.');
  const ranks={high:0,medium:1,low:2};
  return signals.sort((a,b)=>ranks[a.severity]-ranks[b.severity]||a.code.localeCompare(b.code));
}
export function createOperationsOverview(rows,{now=new Date(),limit=50}={}){
  if(!Array.isArray(rows)||rows.length>501||!Number.isSafeInteger(limit)||limit<1||limit>100)
    throw new TypeError('Invalid operations data');
  const items=rows.map(row=>{
    if(!row||typeof row.id!=='string'||!['draft','running','in_review','returned','reviewed','archived'].includes(row.phase))
      throw new TypeError('Invalid pilot summary');
    const alerts=riskForPilot(row,{now});
    return {id:row.id,title:row.title,phase:row.phase,version:row.version,
      lastUpdated:row.updated_at,activePeriods:Number(row.period_count)||0,
      openActions:Number(row.open_actions)||0,overdueActions:Number(row.overdue_actions)||0,
      alerts,priority:alerts.some(s=>s.severity==='high')?'high':
        alerts.length?'medium':'normal'};
  });
  const sortWeight={high:0,medium:1,normal:2};
  items.sort((a,b)=>sortWeight[a.priority]-sortWeight[b.priority]||
    b.overdueActions-a.overdueActions||
    String(a.lastUpdated).localeCompare(String(b.lastUpdated))||
    a.id.localeCompare(b.id));
  const selection=items.slice(0,limit);
  return {
    schema:OPS_SCHEMA,generatedAt:now.toISOString(),returned:selection.length,
    truncated:rows.length>limit,
    totals:{
      atRisk:items.filter(r=>r.priority==='high').length,
      warning:items.filter(r=>r.priority==='medium').length,
      normal:items.filter(r=>r.priority==='normal').length,
      overdueActions:items.reduce((sum,r)=>sum+r.overdueActions,0)
    },items:selection,
    disclaimer:'Сигналы отражают только операционную дисциплину и качество агрегатов. Они не подтверждают прибыль, причинность или наличие реальных гостей.'
  };
}
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function order(list,compare){
  if(!Array.isArray(list)||list.length>500)throw new RangeError('Export data exceeds safe bound');
  return [...list].sort(compare);
}
export function createOperationsExport({
  pilot,evidence,evidenceDigest,actions,history,imports,review
}){
  if(!pilot||!evidence||!/^([a-f0-9]{64})$/.test(String(evidenceDigest)))
    throw new TypeError('Missing valid original evidence');
  if(sha(evidence)!==evidenceDigest)
    throw new Error('Evidence has changed; no operational export allowed');
  const snapshot={
    schema:'osmanx.guest.operations.snapshot.v1',
    pilot:{id:pilot.id,phase:pilot.phase,version:pilot.version,title:pilot.title,
      protocol:pilot.protocol||null,
      protocolRegisteredAt:pilot.protocol_registered_at||null,
      archivedAt:pilot.archived_at||null},
    evidenceSha256:evidenceDigest,
    evidence,
    review:review||null,
    actions:order(actions,(a,b)=>String(a.code).localeCompare(String(b.code))||String(a.id).localeCompare(String(b.id))),
    actionHistory:order(history,(a,b)=>String(a.action_id).localeCompare(String(b.action_id))||
      Number(a.action_version)-Number(b.action_version)),
    importLedger:order(imports,(a,b)=>String(a.created_at).localeCompare(String(b.created_at))||String(a.id).localeCompare(String(b.id)))
  };
  return {format:BUNDLE_SCHEMA,sha256:sha(snapshot),snapshot,
    disclaimer:'SHA-256 обнаруживает изменение пакета, но НЕ является цифровой подписью издателя, доказательством причинного эффекта, оплатой или юридическим сертификатом.'};
}
