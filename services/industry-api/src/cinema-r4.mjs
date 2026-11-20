// CINEMA R4 shared validation: pure, bounded campaign and follow-up state rules.
const fail=(status,message)=>Object.assign(new Error(message),{statusCode:status});
export const CAMPAIGN_RE=/^[a-z0-9][a-z0-9_-]{0,39}$/;
export const FOLLOWUPS=['call','email','proposal','review'];
export const LOSSES=['price','timing','competitor','no_response','out_of_scope','other'];
export function campaignCode(value='direct') {
  if(value===undefined||value===null||value==='')return 'direct';
  if(typeof value!=='string'||!CAMPAIGN_RE.test(value))throw fail(400,'Неверный код кампании');
  return value;
}
export function planFollowup(existing,body,{now=Date.now()}={}) {
  const permitted=['nextActionAt','nextActionKind','lossReasonCode'];
  if(!body||typeof body!=='object'||Array.isArray(body))throw fail(400,'Неверный запрос');
  const has=(name)=>Object.hasOwn(body,name);
  const state=body.state??existing.state;
  let due=has('nextActionAt')?body.nextActionAt:existing.next_action_at;
  let kind=has('nextActionKind')?body.nextActionKind:existing.next_action_kind;
  let loss=has('lossReasonCode')?body.lossReasonCode:existing.loss_reason_code;
  if(due==='')due=null;
  if(kind==='')kind=null;
  if(loss==='')loss=null;
  if(due!==null&&due!==undefined) {
    if(typeof due!=='string' && !(due instanceof Date))throw fail(400,'Дата должна содержать часовой пояс');
    if(typeof due==='string'&&!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(due))
      throw fail(400,'Используйте дату и время с часовым поясом');
    const parsed=Date.parse(due);
    if(!Number.isFinite(parsed))throw fail(400,'Некорректная дата');
    if(has('nextActionAt')&&(parsed<now-60000 || parsed>now+370*86400000))
      throw fail(400,'Планируйте действие в ближайшие 370 дней');
    due=new Date(parsed).toISOString();
  } else due=null;
  if(kind!==null&&kind!==undefined&&!FOLLOWUPS.includes(kind))throw fail(400,'Недопустимое следующее действие');
  kind=kind??null;
  if((due===null)!==(kind===null))throw fail(400,'Действие и дата должны быть указаны вместе');
  if(state==='won'||state==='lost'){
    if(has('nextActionAt')&&due!==null)throw fail(409,'Закрытая заявка не требует следующего действия');
    due=null;kind=null;
  }
  if(state==='lost'){
    if(!LOSSES.includes(loss))throw fail(400,'Укажите причину несостоявшейся сделки');
  } else {
    if(has('lossReasonCode')&&loss!==null)throw fail(409,'Причина отказа относится только к несостоявшимся сделкам');
    loss=null;
  }
  return {state,nextActionAt:due,nextActionKind:kind,lossReasonCode:loss};
}
export function followupWindow(windowName,now=new Date()){
  if(!['overdue','today','next7'].includes(windowName))throw fail(400,'Недопустимый период');
  const date=now instanceof Date?now:new Date(now);
  if(!Number.isFinite(date.getTime()))throw fail(400,'Неверная текущая дата');
  const utcMidnight=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate());
  if(windowName==='overdue')return {before:date.toISOString(),after:null};
  if(windowName==='today')return {after:new Date(utcMidnight).toISOString(),before:new Date(utcMidnight+86400000).toISOString()};
  return {after:date.toISOString(),before:new Date(utcMidnight+8*86400000).toISOString()};
}
export const encodeCampaignLink=(story,campaign)=>{
  if(!/^\d{2}-[a-z-]{3,30}$/.test(story))throw fail(400,'Неизвестный формат сюжета');
  const slug=campaignCode(campaign);
  return 'https://osmanx.world/assets/stories/cinema.html?story='+encodeURIComponent(story)+'&utm_campaign='+encodeURIComponent(slug)+'#episodes';
};
