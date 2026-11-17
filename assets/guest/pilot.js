import {READINESS_KEYS, WEEK_KEYS, MAX_WEEKS, readiness, planSampleSize,
  evaluate, readBundle, reportCsv} from './pilot-model.js';

const byId=id=>document.getElementById(id);
const planFields=['baselinePct','liftPp','margin','discount','fixed','fee'];
const fieldNames={
  date:'Дата начала',control:'Гостей без предложения',controlReturn:'Вернулись без предложения',
  offer:'Гостей с предложением',offerReturn:'Вернулись с предложением'
};
const fmt=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const moneyFmt=new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2});
const DEMO=[
  {date:'2026-11-02',control:100,controlReturn:20,offer:100,offerReturn:28},
  {date:'2026-11-09',control:120,controlReturn:24,offer:120,offerReturn:34}
];
let result=null;
let pendingDownload=null;
function setStatus(message){byId('operationStatus').textContent=message;}
function createPeriod(row){
  const root=document.createElement('fieldset');
  root.className='week';
  const title=document.createElement('h3');
  title.textContent='Период наблюдения';
  const layout=document.createElement('div');layout.className='grid';
  for(const field of WEEK_KEYS){
    const wrap=document.createElement('div');
    const label=document.createElement('label');
    const id='w-'+field+'-'+Math.random().toString(36).slice(2,10);
    label.htmlFor=id;
    label.textContent=fieldNames[field];
    const input=document.createElement('input');
    input.id=id; input.dataset.field=field;input.required=true;
    input.type=field==='date'?'date':'number';
    if(field!=='date'){
      input.min=field==='control'||field==='offer'?'1':'0';
      input.max='10000000';input.step='1';input.inputMode='numeric';
    }
    input.value=String(row?.[field]??'');
    input.addEventListener('input',render);
    wrap.append(label,input);layout.append(wrap);
  }
  const remove=document.createElement('button');
  remove.type='button';remove.className='secondary remove';
  remove.textContent='Убрать период';
  remove.addEventListener('click',()=>{root.remove();renameWeeks();render();});
  root.append(title,layout,remove);
  return root;
}
function renameWeeks(){
  [...byId('weeks').children].forEach((node,i)=>{
    node.querySelector('h3').textContent='Период '+(i+1);
  });
  byId('addWeek').disabled=byId('weeks').children.length>=MAX_WEEKS;
}
function addWeek(row){
  if(byId('weeks').children.length>=MAX_WEEKS){setStatus('Допустимо максимум '+MAX_WEEKS+' периодов.');return;}
  byId('weeks').append(createPeriod(row));
  renameWeeks();render();
}
function rowsFromPage(){
  return [...byId('weeks').children].map(row=>Object.fromEntries(
    [...row.querySelectorAll('[data-field]')].map(input=>[input.dataset.field,input.value])
  ));
}
function input(){
  return {
    plan:Object.fromEntries(planFields.map(k=>[k,byId(k).value])),
    readiness:Object.fromEntries(READINESS_KEYS.map(k=>[k,document.querySelector('[data-ready="'+k+'"]').checked])),
    rows:rowsFromPage(), finalized:byId('finalized').checked
  };
}
function text(id,value){byId(id).textContent=value;}
function clearResult(){
  result=null;
  ['controlRate','offerRate','difference','confidence','finance','outcome'].forEach(id=>text(id,'—'));
  byId('weekTable').replaceChildren();
  byId('risks').replaceChildren();
  byId('report').value='';
  ['copyReport','downloadCSV','downloadJSON'].forEach(id=>byId(id).disabled=true);
}
function render(){
  clearResult();
  try{
    const ready=readiness(input().readiness);
    text('readinessStatus',ready.ready?'6/6 — условия отмечены. Необходима независимая проверка.':
      ready.passed+'/6 — нужно закрыть '+ready.blocking.length+' условий до реального пилота.');
  }catch(err){text('readinessStatus',err.message);}
  try{
    const sample=planSampleSize(byId('baselinePct').value,byId('liftPp').value);
    text('sampleSize',fmt.format(sample.perGroup)+' участников на группу, '+fmt.format(sample.total)+' в обеих группах. Это ориентир без поправки на кластеры.');
  }catch(err){text('sampleSize','Ошибка расчёта выборки: '+err.message);}
  try{
    const evaluation=evaluate(input());
    const {ledger,assessment,sample}=evaluation;
    result=evaluation;
    text('errors','');
    text('controlRate',fmt.format(ledger.c.controlRate*100)+'%');
    text('offerRate',fmt.format(ledger.c.offerRate*100)+'%');
    text('difference',(ledger.c.difference>0?'+':'')+fmt.format(ledger.c.difference*100)+' п.п.');
    text('confidence','Приблизительный 95%-й интервал разницы: '+
      fmt.format(ledger.c.range[0]*100)+' … '+fmt.format(ledger.c.range[1]*100)+' п.п.');
    text('finance','Условный результат: '+moneyFmt.format(assessment.financial.net)+
      '; диапазон по той же модели: '+moneyFmt.format(assessment.financial.rangeNet[0])+
      ' … '+moneyFmt.format(assessment.financial.rangeNet[1])+'.');
    text('outcome',assessment.status+' · '+(assessment.enough?'Объём групп достигнут':'Недостаточная выборка')+
      ' (ориентир: '+fmt.format(sample.perGroup)+' на группу).');
    const body=byId('weekTable');
    for(const w of ledger.weeks){
      const tr=document.createElement('tr');
      for(const value of [w.date,w.controlReturn+'/'+w.control,w.offerReturn+'/'+w.offer,
        (w.difference>0?'+':'')+fmt.format(w.difference*100)+' п.п.']){
        const td=document.createElement('td');
        td.textContent=String(value);tr.append(td);
      }
      body.append(tr);
    }
    const ul=byId('risks');
    for(const risk of assessment.warnings){
      const li=document.createElement('li');li.textContent=risk;ul.append(li);
    }
    byId('report').value=evaluation.report;
    ['copyReport','downloadCSV','downloadJSON'].forEach(id=>byId(id).disabled=false);
  }catch(err){
    text('errors',err.message);
  }
}
function download(filename,content,mime){
  const blob=new Blob([content],{type:mime});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=filename;
  document.body.append(a);
  a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),3000);
}
function resetDemo(){
  for(const k of READINESS_KEYS)document.querySelector('[data-ready="'+k+'"]').checked=false;
  for(const [k,v] of Object.entries({baselinePct:20,liftPp:10,margin:250,discount:0,fixed:0,fee:25000})){
    byId(k).value=String(v);
  }
  byId('weeks').replaceChildren();
  for(const row of DEMO)byId('weeks').append(createPeriod(row));
  byId('finalized').checked=false;
  renameWeeks();render();
  setStatus('Загружены исключительно учебные данные. Ни одна сделка или оплата не подтверждена.');
}
async function loadJson(){
  const file=byId('upload').files?.[0];
  if(!file)return;
  try{
    if(file.size>32768)throw new RangeError('JSON превышает 32 КБ');
    const validated=readBundle(await file.text());
    // All validation precedes UI mutation, preserving the current scenario on failure.
    for(const [k,v] of Object.entries(validated.plan))byId(k).value=String(v);
    for(const [k,v] of Object.entries(validated.readiness)){
      document.querySelector('[data-ready="'+k+'"]').checked=v;
    }
    byId('weeks').replaceChildren();
    for(const row of validated.rows)byId('weeks').append(createPeriod(row));
    byId('finalized').checked=validated.finalized;
    renameWeeks();render();
    setStatus('Сценарий восстановлен после строгой проверки полей. Успешная оплата не подтверждалась.');
  }catch(err){
    setStatus('Импорт отклонён: '+err.message);
  }finally{byId('upload').value='';}
}
document.querySelectorAll('[data-ready]').forEach(check=>check.addEventListener('change',render));
for(const id of planFields)byId(id).addEventListener('input',render);
byId('finalized').addEventListener('change',render);
byId('addWeek').addEventListener('click',()=>addWeek(null));
byId('loadDemo').addEventListener('click',resetDemo);
byId('pilotPreset').addEventListener('click',()=>{byId('fee').value='25000';render();});
byId('monthlyPreset').addEventListener('click',()=>{byId('fee').value='15000';render();});
byId('downloadCSV').addEventListener('click',()=>{
  if(!result)return;
  download('osmanx-guest-pilot-report.csv',reportCsv(result),'text/csv;charset=utf-8');
  setStatus('CSV создан из агрегированных данных локально.');
});
byId('downloadJSON').addEventListener('click',()=>{
  if(!result)return;
  download('osmanx-guest-pilot-scenario.json',JSON.stringify(result.data,null,2)+'\n','application/json;charset=utf-8');
  setStatus('JSON создан локально. Не добавляйте в него личные сведения.');
});
byId('copyReport').addEventListener('click',async()=>{
  if(!result)return;
  try{await navigator.clipboard.writeText(result.report);setStatus('Отчёт скопирован.');}
  catch{byId('report').focus();byId('report').select();setStatus('Отчёт выделен для копирования вручную.');}
});
byId('upload').addEventListener('change',loadJson);
resetDemo();
