import {cohort,economics,csv} from './experiment-model.js';
const $=id=>document.getElementById(id);
const ids=['control','controlReturn','offer','offerReturn','margin','discount','fixed','fee'];
const number=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});
const rub=new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:0});
let latest=null;
function input(){return Object.fromEntries(ids.map(k=>[k,$(k).value]));}
function render(){
  try{
    const data=input(); const c=cohort(data); const e=economics(data,c); latest={data,c,e};
    $('error').textContent='';
    $('numbers').textContent=`Сравнение: ${number.format(c.controlRate*100)}% → ${number.format(c.offerRate*100)}%; разница ${c.difference>=0?'+':''}${number.format(c.difference*100)} п.п.`;
    $('interval').textContent=`Приблизительный 95%-й интервал разницы: ${number.format(c.range[0]*100)}…${number.format(c.range[1]*100)} п.п. ${c.uncertain?'Интервал включает ноль: неопределённость высока.':'Интервал не включает ноль; это всё равно не доказывает причинность.'}`;
    $('net').textContent=`Условный финансовый итог: ${rub.format(e.net)} при ${number.format(e.incrementalVisits)} дополнительных визитах по сценарию.`;
    $('threshold').textContent=e.breakEven===null?'При нулевой марже порог окупаемости не вычисляется.':`Порог покрытия всех перечисленных затрат: ${number.format(e.breakEven)} дополнительных визитов.`;
    $('export').disabled=false;
  }catch(err){
    latest=null; $('error').textContent=err.message;
    ['numbers','interval','net','threshold'].forEach(k=>$(k).textContent='—');
    $('export').disabled=true;
  }
}
for(const id of ids) $(id).addEventListener('input',render);
$('export').addEventListener('click',()=>{
  if(!latest)return;
  const {data,c,e}=latest;
  const rows=[
    ['OSMANX Guest Intelligence','Сценарий без персональных данных'],
    ['Параметр','Значение'],
    ...Object.entries(data).map(([k,v])=>[k,v]),
    ['Разница в долях',c.difference],
    ['Нижняя граница 95%',c.range[0]],
    ['Верхняя граница 95%',c.range[1]],
    ['Условные дополнительные визиты',e.incrementalVisits],
    ['Условный финансовый результат (₽)',e.net],
    ['Порог визитов',e.breakEven??'не определён'],
    ['Ограничение','Данные не доказывают причинную связь; проверьте сопоставимость групп и дополнительные расходы']
  ];
  const blob=new Blob([csv(rows)],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='guest-intelligence-scenario.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('copyBrief').addEventListener('click',async()=>{
  const text=`Заявка на пилот OSMANX Guest Intelligence. Точка: [название]. Период сравнения: [даты]. Главный показатель: повторный визит. Доступные агрегированные данные: [описание]. Кто утверждает эксперимент: [ответственный]. Нужен план измерения и условия пилота.\nНикаких персональных данных гостей в письме не прикладываю.`;
  try{await navigator.clipboard.writeText(text);$('briefStatus').textContent='Шаблон скопирован.';}
  catch{$('briefStatus').textContent='Скопировать не получилось. Используйте ссылку «Запросить пилот».';}
});
render();
