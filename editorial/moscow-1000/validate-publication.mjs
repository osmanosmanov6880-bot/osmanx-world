import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const fields=['researched','visits','dialogues','decisionMeetings','proposals','pilots','contracts'];
const exactly=(obj,keys)=>obj&&typeof obj==='object'&&!Array.isArray(obj)&&Object.keys(obj).every(k=>keys.includes(k));
const safeText=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&& !/[<>]/.test(v) && !/(?:[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|(?:\+7|8)[\s()\-]*\d{3}[\s()\-]*\d{3})/i.test(v);
export function validatePublication(p){
  const errors=[];
  if(!exactly(p,['schemaVersion','status','reviewedAt','reviewer','method','metrics','days']))errors.push('Unexpected top-level field');
  if(p?.schemaVersion!==2)errors.push('schemaVersion must be 2');
  if(!['published','unpublished'].includes(p?.status))errors.push('Invalid publication status');
  if(!Array.isArray(p?.days)||p.days.length>10)errors.push('Invalid day list');
  if(p?.status==='unpublished'){
    if(p.metrics!==null || p.days.length || p.reviewedAt!==null || p.reviewer!==null)errors.push('Unpublished release cannot expose data');
  } else {
    if(!/^20\d{2}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(p.reviewedAt||'')||Number.isNaN(Date.parse(p.reviewedAt)))errors.push('Approval timestamp required');
    if(!safeText(p.reviewer,80)||!safeText(p.method,500))errors.push('Reviewer and methodology required');
    if(!exactly(p.metrics,fields) || fields.some(k=>!Number.isSafeInteger(p.metrics[k])||p.metrics[k]<0))errors.push('Missing or invalid metric counters');
    if(p.metrics && Number.isSafeInteger(p.metrics.researched) && p.metrics.researched>1000000)errors.push('Research counter unreasonable');
    if(p.metrics && p.metrics.pilots>p.metrics.proposals)errors.push('Pilots exceed proposals; explain via separate workflow first');
    if(p.metrics && p.metrics.visits>p.metrics.researched)errors.push('Visits exceed researched objects');
    for(const x of p.days){
      if(!exactly(x,['day','summary','lesson','approvedForWeb'])||!Number.isInteger(x.day)||x.day<1||x.day>10||x.approvedForWeb!==true||!safeText(x.summary,500)||!safeText(x.lesson,350))errors.push('Invalid or sensitive day summary');
    }
    if(new Set(p.days.map(x=>x.day)).size!==p.days.length)errors.push('Repeated day in summaries');
  }
  return errors;
}
if(import.meta.url===`file://${process.argv[1]}`){
  const [, , input, output, flag]=process.argv;
  if(!input||!output||flag!=='--confirm-publication'){console.error('Usage: node validate-publication.mjs input.json output.js --confirm-publication');process.exit(2);}
  const parsed=JSON.parse(readFileSync(resolve(input),'utf8'));
  const errors=validatePublication(parsed);
  if(errors.length){console.error('Publication blocked: '+errors.join('; '));process.exit(1);}
  writeFileSync(resolve(output),`/* Explicitly reviewed editorial public data. Never import CRM state. */\nwindow.OSMANX_APPROVED_PUBLICATION=Object.freeze(${JSON.stringify(parsed,null,2)});\n`);
  console.log('Public release validated: '+parsed.status+'; day summaries: '+parsed.days.length);
}
