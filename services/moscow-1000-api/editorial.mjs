/** Explicit editorial verification model. Draft metadata/evidence references never leave the admin API. */
const metricKeys=['researched','visits','dialogues','decisionMeetings','proposals','pilots','contracts'];
const safe=(s,max=500)=>typeof s==='string'&&s.trim().length>0&&s.length<=max&&!/[<>\u0000-\u001f\u007f]/.test(s)&&
  !/(?:[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\+7|8)[\s()\-]*\d{3}[\s()\-]*\d{3})/i.test(s);
const ref=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{6,80}$/.test(s);
const isObj=o=>o&&typeof o==='object'&&!Array.isArray(o);
const exact=(o,keys)=>isObj(o)&&Object.keys(o).every(k=>keys.includes(k));
const isDay=n=>Number.isSafeInteger(n)&&n>=1&&n<=10;
const metricValid=m=>m===null||(exact(m,metricKeys)&&metricKeys.every(k=>Number.isSafeInteger(m[k])&&m[k]>=0&&m[k]<=1_000_000));
export const emptyDraft=()=>({schemaVersion:3,method:'',metrics:null,days:[],markers:[],episodes:[]});
export function validateDraft(doc,{strict=false}={}){
  const problems=[];
  if(!exact(doc,['schemaVersion','method','metrics','days','markers','episodes'])||doc.schemaVersion!==3)return ['Unsupported document schema'];
  if(typeof doc.method!=='string'||doc.method.length>600||/[<>\u0000-\u001f]/.test(doc.method)||(strict&&!safe(doc.method,600)))problems.push('Invalid methodology');
  if(!metricValid(doc.metrics))problems.push('Metric counters invalid');
  if(!Array.isArray(doc.days)||doc.days.length>10)problems.push('Invalid day count');
  if(!Array.isArray(doc.markers)||doc.markers.length>60)problems.push('Invalid public marker count');
  if(!Array.isArray(doc.episodes)||doc.episodes.length>10)problems.push('Invalid episodes');
  if(problems.length)return problems;
  if(doc.metrics&&doc.metrics.visits>doc.metrics.researched)problems.push('Visits exceed researched records');
  if(doc.metrics&&doc.metrics.pilots>doc.metrics.proposals)problems.push('Pilots exceed proposals');
  const unique=(items,key)=>new Set(items.map(key)).size===items.length;
  if(!unique(doc.days,d=>d.day))problems.push('Duplicate day');
  if(!unique(doc.markers,m=>m.id))problems.push('Duplicate marker');
  if(!unique(doc.episodes,e=>e.day))problems.push('Duplicate published episode');
  for(const d of doc.days){if(!exact(d,['day','summary','lesson','evidenceRef','permissionChecked'])||!isDay(d.day)||!safe(d.summary,500)||!safe(d.lesson,350)||!ref(d.evidenceRef)||d.permissionChecked!==true)problems.push('Invalid or unverified day finding');}
  for(const m of doc.markers){if(!exact(m,['id','day','title','lat','lng','summary','episode','evidenceRef','permissionChecked'])||
    !ref(m.id)||!isDay(m.day)||!safe(m.title,90)||!safe(m.summary,350)||!Number.isFinite(m.lat)||!Number.isFinite(m.lng)||
    m.lat<55.3||m.lat>56.2||m.lng<36.5||m.lng>38.5||!isDay(m.episode)||m.day!==m.episode||!ref(m.evidenceRef)||m.permissionChecked!==true)problems.push('Unverified or unsafe public marker');}
  for(const e of doc.episodes){if(!exact(e,['day','title','videoUrl','publishedAt','rightsConfirmed','evidenceRef'])||
    !isDay(e.day)||!safe(e.title,120)||typeof e.videoUrl!=='string'||!/^\/assets\/[-\w/.]+\.(mp4|webm)$/.test(e.videoUrl)||
    e.videoUrl.includes('..')||!/^20\d{2}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(e.publishedAt||'')||
    !ref(e.evidenceRef)||e.rightsConfirmed!==true)problems.push('Unverified documentary episode');}
  if(strict&&!doc.metrics&&!doc.days.length&&!doc.markers.length&&!doc.episodes.length)problems.push('Nothing to publish');
  return problems;
}
export function buildPublicRelease(draft,version,reviewedAt){
  return {schemaVersion:3,status:'published',version,reviewedAt,method:draft.method,
    metrics:draft.metrics?Object.fromEntries(metricKeys.map(k=>[k,draft.metrics[k]])):null,
    days:draft.days.map(d=>({day:d.day,summary:d.summary,lesson:d.lesson,approvedForWeb:true})),
    markers:draft.markers.map(m=>({id:m.id,day:m.day,title:m.title,lat:Math.round(m.lat*1000)/1000,lng:Math.round(m.lng*1000)/1000,summary:m.summary,episode:m.episode})),
    episodes:draft.episodes.map(e=>({day:e.day,title:e.title,videoUrl:e.videoUrl,publishedAt:e.publishedAt}))};
}
export const unpublished=()=>({schemaVersion:3,status:'unpublished',version:null,reviewedAt:null,method:null,metrics:null,days:[],markers:[],episodes:[]});
