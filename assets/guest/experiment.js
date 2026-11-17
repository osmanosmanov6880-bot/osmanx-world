import {cohort,economics,csv,createSnapshot,readSnapshot,pilotBrief,protocol,riskFlags,INPUT_KEYS} from './experiment-model.js';
const $=id=>document.getElementById(id);
const integer=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});
const rub=new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2});
const protocolKeys=['startDate','endDate','allocation','outcomeWindowDays'];
let latest=null, snapshot=null;
const values=keys=>Object.fromEntries(keys.map(key=>[key,$(key).value]));
function setStatus(message){$('status').textContent=message;}
function render(){
  latest=null;snapshot=null;
  $('downloadCsv').disabled=true;
  $('downloadJson').disabled=true;
  $('copyBrief').disabled=true;
  $('briefText').value='';
  $('riskList').replaceChildren();
  try{
    const inputs=values(INPUT_KEYS);
    const c=cohort(inputs), e=economics(inputs,c);
    latest={inputs,c,e};
    $('errors').textContent='';
    $('numbers').textContent='Контроль '+integer.format(c.controlRate*100)+'% · Предложение '+integer.format(c.offerRate*100)+'% · Разница '+(c.difference>=0?'+':'')+integer.format(c.difference*100)+' п.п.';
    $('interval').textContent='Приблизительный 95%-й интервал: '+integer.format(c.range[0]*100)+'…'+integer.format(c.range[1]*100)+' п.п.';
    $('net').textContent='Условный чистый результат: '+rub.format(e.net)+' (с учётом расходов '+rub.format(e.costs)+').';
    $('netRange').textContent='Сценарный диапазон результата: '+rub.format(e.rangeNet[0])+' — '+rub.format(e.rangeNet[1])+'.';
    $('visits').textContent='Оценка дополнительных визитов по разности долей: '+integer.format(e.incrementalVisits)+'.';
    $('threshold').textContent=e.breakEven===null?'При нулевой марже порог окупаемости не вычисляется.':'Требуемые дополнительные визиты для покрытия затрат: '+integer.format(e.breakEven)+'.';
    $('downloadCsv').disabled=false;
    const inputProtocol=values(protocolKeys);
    try{
      const p=protocol(inputProtocol);
      snapshot=createSnapshot(inputs,inputProtocol);
      $('briefText').value=pilotBrief(snapshot);
      $('briefNotice').textContent='Протокол заполнен. Это проект, а не акт принятия результата.';
      $('downloadJson').disabled=false;
      $('copyBrief').disabled=false;
      for(const flag of riskFlags(c,p)) {
        const item=document.createElement('li');item.textContent=flag;$('riskList').append(item);
      }
    } catch (err) {
      $('briefNotice').textContent='Для паспорта пилота: '+err.message;
      const item=document.createElement('li');item.textContent=c.small?'Для небольших групп результат может быть нестабилен.':'Убедитесь в сопоставимости групп и корректном сборе данных.';
      $('riskList').append(item);
    }
  }catch(err){
    $('errors').textContent=err.message;
    for(const id of ['numbers','interval','net','netRange','visits','threshold']) $(id).textContent='—';
    $('briefNotice').textContent='Исправьте исходные числа для расчёта.';
  }
}
function download(filename,content,type){
  const blob=new Blob([content],{type});
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement('a');
  anchor.href=url;anchor.download=filename;
  document.body.append(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportCsv(){
  if(!latest)return;
  const {inputs,c,e}=latest;
  const rows=[
    ['OSMANX Guest Intelligence','Сценарий, не причинное доказательство'],
    ['Параметр','Значение'],...Object.entries(inputs),
    ['Доля контроля',c.controlRate],['Доля предложения',c.offerRate],
    ['Разница долей',c.difference],['Интервал нижняя',c.range[0]],['Интервал верхняя',c.range[1]],
    ['Условные дополнительные визиты',e.incrementalVisits],['Все учтённые расходы в ₽',e.costs],
    ['Чистый результат в ₽',e.net],['Нижний сценарий в ₽',e.rangeNet[0]],['Верхний сценарий в ₽',e.rangeNet[1]],
    ['Порог дополнительных визитов',e.breakEven??'не определён'],
    ['Предупреждение','Не причинный эффект. Для реального исследования проверяйте пересечения гостей и формирование групп.']
  ];
  download('osmanx-guest-scenario.csv',csv(rows),'text/csv;charset=utf-8');
  setStatus('CSV подготовлен локально без отправки данных.');
}
function exportJson(){
  if(!snapshot)return;
  download('osmanx-guest-pilot.json',JSON.stringify(snapshot,null,2)+'\n','application/json;charset=utf-8');
  setStatus('Паспорт сценария сохранён в JSON. На сервер ничего не отправлено.');
}
async function importJson(){
  const file=$('importJson').files[0];
  if(!file)return;
  try{
    if(file.size>16384)throw new RangeError('Файл слишком большой (максимум 16 КБ)');
    const parsed=readSnapshot(await file.text());
    for(const key of INPUT_KEYS)$(key).value=parsed.inputs[key];
    for(const key of protocolKeys)$(key).value=parsed.protocol[key];
    render();
    setStatus('Сценарий импортирован и заново проверен.');
  }catch(err){setStatus('Импорт отклонён: '+err.message);}
  finally{$('importJson').value='';}
}
for(const id of [...INPUT_KEYS,...protocolKeys]) $(id).addEventListener('input',render);
$('downloadCsv').addEventListener('click',exportCsv);
$('downloadJson').addEventListener('click',exportJson);
$('importJson').addEventListener('change',importJson);
$('copyBrief').addEventListener('click',async()=>{
  if(!snapshot)return;
  const value=$('briefText').value;
  try{
    await navigator.clipboard.writeText(value);
    setStatus('Паспорт пилота скопирован.');
  }catch{
    $('briefText').focus();$('briefText').select();
    setStatus('Текст выделен. Скопируйте его обычной командой.');
  }
});
$('presetPilot').addEventListener('click',()=>{$('fee').value='25000';render();setStatus('Цена пилота: 25 000 ₽ разово. Это гипотеза, не счёт на оплату.');});
$('presetMonthly').addEventListener('click',()=>{$('fee').value='15000';render();setStatus('Цена сопровождения: 15 000 ₽ в месяц. Это гипотеза, не подписка.');});
render();
