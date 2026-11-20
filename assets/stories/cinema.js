(() => {
'use strict';
const root='/assets/stories/';
const slides=[
 ['Цена невидимых потерь','Цена невидимых потерь — постановочная сцена ресторана'],
 ['Гость не вернулся','Гость не вернулся — постановочный пример'],
 ['Продажа не состоялась','Покупатель не нашёл нужный размер'],
 ['Свободное кресло','Свободное время специалиста'],
 ['Диагностика вместо догадок','Переход от отчётов к проверке гипотез'],
 ['Теперь смотрите','Переход к четырём главам фильма']
];
const img=document.getElementById('slide-image');const caption=document.getElementById('slide-caption');const number=document.getElementById('slide-number');const line=document.getElementById('slide-progress');const prev=document.getElementById('prev-slide');const next=document.getElementById('next-slide');
let slide=0;
function showSlide(i){const n=Math.max(0,Math.min(slides.length-1,i));slide=n;img.classList.add('changing');const target=root+'slides/scene-'+(n+1)+'.webp';const loader=new Image();loader.onload=()=>{if(slide!==n)return;img.src=target;img.alt='Слайд '+(n+1)+': '+slides[n][1];caption.textContent=slides[n][0];number.textContent=String(n+1).padStart(2,'0');line.style.width=((n+1)*100/slides.length)+'%';prev.disabled=n===0;next.disabled=n===slides.length-1;img.classList.remove('changing');};loader.onerror=()=>img.classList.remove('changing');loader.src=target;}
prev.addEventListener('click',()=>showSlide(slide-1));next.addEventListener('click',()=>{if(slide===slides.length-1){document.getElementById('theater').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}else showSlide(slide+1);});
for(const el of [prev,next])el.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'){e.preventDefault();showSlide(slide-1)}if(e.key==='ArrowRight'){e.preventDefault();showSlide(slide+1)}});
const film=document.getElementById('hero-film'),play=document.getElementById('film-start');play.addEventListener('click',()=>{play.hidden=true;film.play().catch(()=>{play.hidden=false;});});film.addEventListener('play',()=>play.hidden=true);film.addEventListener('pause',()=>{if(film.currentTime===0)play.hidden=false;});
const episodes=[
{id:'01-restaurant',group:'hospitality',category:'РЕСТОРАНЫ',title:'Клиент ушёл навсегда',description:'Последний визит может выглядеть как обычный ужин. Причину невозврата нужно исследовать.',href:'/assets/guest/offer.html',cta:'Проверить возврат гостей'},
{id:'07-coffee',group:'hospitality',category:'КОФЕЙНИ',title:'Заказ, которого не было',description:'Очередь в час пик скрывает посетителей, ушедших без покупки. Как их заметить?',href:'/assets/guest/offer.html',cta:'Проверить гипотезу'},
{id:'08-return',group:'hospitality',category:'РЕСТОРАНЫ',title:'Они не вернулись',description:'Даже удачный вечер не объясняет, почему следующего визита не произошло.',href:'/assets/guest/offer.html',cta:'Исследовать повторные визиты'},
{id:'02-fashion',group:'retail',category:'ОДЕЖДА',title:'Не было моего размера',description:'Покупатель хотел купить. Система видит остатки, но не всегда видит неудовлетворённый спрос.',href:'/assets/sovereign/workspace.html?app=retail',cta:'Открыть Retail Intelligence'},
{id:'12-shoes',group:'retail',category:'ОБУВЬ',title:'Нужный размер отсутствует',description:'Неотмеченный запрос на размер может означать потерянную продажу.',href:'/assets/sovereign/workspace.html?app=retail',cta:'Исследовать спрос'},
{id:'03-dentistry',group:'health',category:'СТОМАТОЛОГИЯ',title:'Пустое кресло',description:'Свободное время врача не вернётся. Надо выяснить, на каком этапе теряется запись.',href:'/assets/industry/index.html',cta:'Отраслевые решения'},
{id:'09-appointment',group:'health',category:'КЛИНИКИ',title:'Пациент не пришёл',description:'Пропущенная запись — повод проверить подтверждения, напоминания и путь клиента.',href:'/assets/industry/index.html',cta:'Проверить процесс записи'},
{id:'04-auto',group:'service',category:'АВТОСЕРВИС',title:'Не дождался ответа',description:'Если на запрос никто не ответил, свободный подъёмник не помогает бизнесу.',href:'/assets/industry/index.html',cta:'Посмотреть систему'},
{id:'05-fitness',group:'service',category:'ФИТНЕС',title:'Абонемент не продлён',description:'Мотивы ухода участника нельзя надёжно понять по одному числу продлений.',href:'/assets/industry/index.html',cta:'Исследовать удержание'},
{id:'10-construction',group:'service',category:'СТРОИТЕЛЬСТВО',title:'Заявка исчезла',description:'Дорогой проект может сорваться ещё до коммерческого предложения.',href:'/assets/industry/index.html',cta:'Решения для услуг'},
{id:'11-logistics',group:'service',category:'ЛОГИСТИКА',title:'Доставка ушла конкуренту',description:'Своевременный ответ и прозрачный статус могут быть критичными для выбора подрядчика.',href:'/assets/industry/index.html',cta:'Решения для логистики'},
{id:'06-education',group:'education',category:'ОБРАЗОВАНИЕ',title:'Курс не закончили',description:'Зачисление — только начало. Важно понимать, в какой момент человек перестал учиться.',href:'/assets/catalog/index.html',cta:'Изучить продукты'}
];
const grid=document.getElementById('episode-grid');
for(let i=0;i<episodes.length;i++){const ep=episodes[i];const card=document.createElement('article');card.className='episode';card.dataset.group=ep.group;const button=document.createElement('button');button.className='episode-image';button.type='button';button.setAttribute('aria-label','Смотреть в MARCOSA: '+ep.title);const poster=document.createElement('img');poster.src=root+'posters/'+ep.id+'.webp';poster.loading='lazy';poster.decoding='async';poster.alt='Кадр постановочного видео: '+ep.category.toLowerCase();const count=document.createElement('span');count.className='episode-number';count.textContent=String(i+1).padStart(2,'0')+' / 12';const playText=document.createElement('span');playText.className='episode-play';playText.textContent='СМОТРЕТЬ 15 СЕК.  ▶';button.append(poster,count,playText);button.addEventListener('click',()=>openEpisode(ep,button));const details=document.createElement('div');details.className='episode-text';const cat=document.createElement('span');cat.className='category';cat.textContent=ep.category;const heading=document.createElement('h3');heading.textContent=ep.title;const desc=document.createElement('p');desc.textContent=ep.description;const link=document.createElement('a');link.href=ep.href;link.textContent=ep.cta+' ↗';details.append(cat,heading,desc,link);card.append(button,details);grid.append(card);}
const filters=[...document.querySelectorAll('[data-filter]')];filters.forEach(b=>b.addEventListener('click',()=>{const val=b.dataset.filter;let visible=0;for(const card of grid.querySelectorAll('.episode')){card.hidden=val!=='all'&&card.dataset.group!==val;if(!card.hidden)visible++;}for(const f of filters){const active=f.dataset.filter===val;f.classList.toggle('active',active);f.setAttribute('aria-pressed',String(active));}grid.setAttribute('aria-label',visible+' видеоисторий');}));
const dialog=document.getElementById('episode-dialog'),player=document.getElementById('dialog-video'),title=document.getElementById('dialog-title'),sector=document.getElementById('dialog-sector'),download=document.getElementById('dialog-download'),cta=document.getElementById('dialog-cta');let previousFocus;
function openEpisode(ep,button){if(!ep||!button)return;film.pause();window.location.assign('https://marcosa.club/#series');}
function closeEpisode(){if(dialog.open)dialog.close();}
document.getElementById('dialog-close').addEventListener('click',closeEpisode);dialog.addEventListener('click',event=>{if(event.target===dialog)closeEpisode();});dialog.addEventListener('close',()=>{player.pause();player.removeAttribute('src');player.load();previousFocus?.focus();});
})();
