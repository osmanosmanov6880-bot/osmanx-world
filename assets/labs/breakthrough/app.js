/* BREAKTHROUGH ENGINEERING ADVENTURE — functional teaching state machine.
   Educational water simulator: simplified gravity-driven flow, mass conservation,
   trial / feedback / assembly / mastery; stores only local guest progress. */
(function(){
'use strict';
const SAVE_KEY='breakthrough-waterlab-prototype-v1';
const STEP_NAMES=['Знакомство','Открой кран','Как это работает','Эксперимент','Догадка','Собери сам','Открытие'];
const PARTS={tank:{name:'Бак с водой',icon:'▥'},pipe:{name:'Трубка',icon:'〰'},valve:{name:'Кран',icon:'✳'},bottle:{name:'Бутылка',icon:'♧'}};
const SLOTS={tank:{caption:'ОТКУДА ВОДА?',name:'Источник'},pipe:{caption:'КУДА ОНА ИДЁТ?',name:'Путь воды'},valve:{caption:'КТО УПРАВЛЯЕТ?',name:'Управление'},bottle:{caption:'КУДА НАЛИВАЕМ?',name:'Цель'}};
const TIPS=[
 'Не нужно знать физику. Просто пробуй и смотри, что получается.',
 'Кран на 3D-модели тоже настоящий: попробуй нажать на него!',
 'Светящаяся трубка показывает путь воды, а не просто украшает сцену.',
 'Смотри на число «мл/с» под лабораторией — это скорость потока.',
 'Не угадал? Это не ошибка. Сравни результат и сделай новое открытие.',
 'Деталь можно перетащить мышью или выбрать нажатием и указать место.',
 'Инженер — человек, который пробует, проверяет и улучшает идеи.'
];
const VOICES=[
 'Привет! Это твоя первая инженерная лаборатория. Перед тобой бак с водой, трубка, кран и пустая бутылка. Давай оживим эту установку.',
 'Попробуй открыть оранжевый кран. Посмотри, как вода попадает в бутылку.',
 'Вода из бака движется по трубке к бутылке. Нажми «Показать путь», чтобы увидеть маршрут воды.',
 'Как изменится поток, если кран открыт только наполовину? Передвинь ползунок примерно на 50 процентов и понаблюдай.',
 'Как ты думаешь, что будет, если открыть кран полностью? Выбери свой ответ и проверь его.',
 'Теперь собираем установку! Установи бак, трубку, кран и бутылку на нужные места. Затем запусти своё устройство.',
 'Поздравляем! Ты научился управлять потоком, проверять гипотезу и соединять детали в работающий механизм.'
];
const $=sel=>document.querySelector(sel);
const el={guide:$('#guideBody'),steps:$('#journeySteps'),count:$('#journeyCount'),pill:$('#stepPill'),tip:$('#bottomTip'),tank:$('#tankVal'),flow:$('#flowVal'),bottle:$('#bottleVal'),indicator:$('#waterIndicatorText'),indicatorSub:$('#waterIndicatorSub'),hotspot:$('#valveHotspot'),fallback:$('#sceneFallback'),modal:$('#helpModal'),announcer:$('#announcer'),canvas:$('#sceneCanvas')};
const blankState=()=>({step:0,maxStep:0,valve:0,tank:1600,bottle:0,observedOpen:false,shownPath:false,halfObserved:false,halfSeconds:0,prediction:null,predictionChecked:false,parts:{tank:false,pipe:false,valve:false,bottle:false},selectedPart:null,buildRun:false,buildComplete:false,completed:false,feedback:'',startedAt:Date.now()});
let state=blankState(),scene=null,savePending=0,lastTick=0,helpPrevFocus=null;
function load(){try{const str=localStorage.getItem(SAVE_KEY);if(!str)return;const raw=JSON.parse(str);if(!raw||raw.version!==1||!raw.data)return;const r=raw.data;const clean=blankState();if(!Number.isInteger(r.step)||r.step<0||r.step>6)return;clean.step=r.step;clean.maxStep=Math.max(clean.step,Math.min(6,Math.max(0,Number(r.maxStep)||0)));clean.valve=Math.max(0,Math.min(1,Number(r.valve)||0));clean.tank=Math.max(0,Math.min(1600,Number(r.tank)||0));clean.bottle=Math.max(0,Math.min(500,Number(r.bottle)||0));for(const k of ['observedOpen','shownPath','halfObserved','predictionChecked','buildRun','buildComplete','completed'])clean[k]=!!r[k];clean.halfSeconds=Math.max(0,Math.min(3,Number(r.halfSeconds)||0));clean.prediction=[0,1,2].includes(r.prediction)?r.prediction:null;for(const k in clean.parts)clean.parts[k]=!!r.parts?.[k];clean.selectedPart=null;clean.feedback='';clean.startedAt=Number(r.startedAt)||Date.now();state=clean;}catch(e){console.warn('Progress could not be restored',e)}}
function save(){try{localStorage.setItem(SAVE_KEY,JSON.stringify({version:1,data:state,savedAt:new Date().toISOString()}));}catch(e){/* private storage can be blocked */}}
function announce(t){el.announcer.textContent='';requestAnimationFrame(()=>el.announcer.textContent=t)}
function flowRate(){if(state.valve<=.001||state.tank<=.01||state.bottle>=500||!canFlow())return 0;
  // Teaching model Q = C * opening * sqrt(h / hRef), with fixed initial head.
  // Coefficient calibrated for observable gameplay, NOT a certified machine design.
  const normalizedHead=.76+.24*(state.tank/1600);
  return 112*state.valve*Math.sqrt(Math.max(0,normalizedHead));}
function fullRate(){return 112*Math.sqrt(Math.max(0,.76+.24*(state.tank/1600)))}
function canFlow(){return state.step!==5||Object.values(state.parts).every(Boolean)}
function freshWater(v=0){state.tank=1600;state.bottle=0;state.valve=v;savePending=0;updateNumbers()}
function openValve(){if(state.step===0||state.step===2||state.step===6){announce('Следуй заданию на карточке справа.');return}if(state.step===4&&!state.predictionChecked){announce('Сначала выбери догадку — тогда проверим её вместе.');return}if(state.step===5&&!Object.values(state.parts).every(Boolean)){announce('Сначала собери все четыре детали.');return}state.valve=state.valve>.05?0:1;if(state.step===5&&state.valve>0)state.buildRun=true;save();updateNumbers();renderGuide();announce(state.valve>0?'Кран открыт. Вода течёт!':'Кран закрыт. Поток остановился.')}
function enterStep(index){state.step=index;state.maxStep=Math.max(state.maxStep,index);state.feedback='';state.selectedPart=null;
 if(index===1){freshWater(0);state.observedOpen=false}
 if(index===2){freshWater(.66);state.shownPath=false}
 if(index===3){freshWater(1);state.halfObserved=false;state.halfSeconds=0}
 if(index===4){freshWater(.5);state.prediction=null;state.predictionChecked=false}
 if(index===5){freshWater(0);state.parts={tank:false,pipe:false,valve:false,bottle:false};state.buildRun=false;state.buildComplete=false}
 if(index===6){state.valve=0;state.completed=true}
 save();renderGuide();updateNumbers();window.scrollTo({top:0,behavior:'smooth'});announce(`Шаг ${index+1} из 7. ${VOICES[index]}`)}
function advance(){const i=state.step;if(i===1&&!state.observedOpen)return;if(i===2&&!state.shownPath)return;if(i===3&&!state.halfObserved)return;if(i===4&&!state.predictionChecked)return;if(i===5&&!state.buildComplete)return;if(i>=6)return;enterStep(i+1)}
function renderJourney(){el.steps.innerHTML=STEP_NAMES.map((name,i)=>`<div class="journey-step ${i===state.step?'current':i<state.maxStep||state.completed?'done':''}" ${i===state.step?'aria-current="step"':''}><div class="step-number">${i<state.maxStep||state.completed?'✓':String(i+1).padStart(2,'0')}</div><span class="step-name">${name}</span></div>`).join('');el.count.textContent=`Шаг ${state.step+1} из 7`;el.pill.textContent=`ШАГ ${String(state.step+1).padStart(2,'0')} / 07`}
function startFrame(overline,title,body){return `<div class="overline">${overline}</div><h2>${title}</h2><p>${body}</p>`}
function btn(action,label,symbol='→',cls='primary-btn',attrs=''){return `<button class="${cls}" data-action="${action}" ${attrs}>${label}<span aria-hidden="true">${symbol}</span></button>`}
function callout(message){return `<div class="positive-callout"><span class="check">✓</span><span>${message}</span></div>`}
function renderGuide(){renderJourney();el.tip.textContent=TIPS[state.step];let html='';const s=state;
 switch(s.step){
 case 0:
 html=startFrame('ПРИВЕТ, ИЗОБРЕТАТЕЛЬ!','Готов оживить свою первую машину?','Это маленькая водяная станция. Сейчас вода в баке, а бутылка пустая. Думаешь, мы сможем её наполнить?')+
 `<div class="example-bubble"><b>Твоя миссия:</b> узнать, как управлять водой, и построить такую установку самостоятельно.</div>`+
 `<div class="button-stack">${btn('next','Поехали!','→')}${btn('open-help','Как управлять 3D-моделью?','↗','secondary-btn')}</div>`;
 break;
 case 1:
 html=startFrame('МИССИЯ № 1','Помоги воде добраться до бутылки.','Посмотри на оранжевый кран. Пока он закрыт, вода не может пройти по трубке. Попробуй открыть его!')+
 `<div class="small-goal"><strong>Задание:</strong> открой кран и набери хотя бы 120 мл воды.</div>`+
 (s.observedOpen?callout(`Получилось! Вода попала в бутылку. Ты управляешь потоком!`):'')+
 `<div class="button-stack">${s.observedOpen?btn('next','Узнать, почему вода течёт'):btn('toggle-valve',s.valve>.05?'Закрыть кран':'Открыть кран','↗')}${btn('repeat','Повторить опыт','↺','secondary-btn')}</div>`+
 `<p class="hint-line">Можно нажать на оранжевый кран прямо в 3D-сцене.</p>`;
 break;
 case 2:
 html=startFrame('ТВОЁ ПЕРВОЕ ОТКРЫТИЕ','Вода нашла дорогу!','В баке вода находится выше бутылки. Благодаря силе тяжести и перепаду давления она движется по открытой трубке вниз.')+
 `<div class="arrow-map"><span>Бак<br>с водой</span><i>→</i><span>Трубка<br>и кран</span><i>→</i><span>Пустая<br>бутылка</span></div>`+
 (s.shownPath?callout('Бирюзовая линия на установке показывает, по какому пути может двигаться вода.'):'')+
 `<div class="button-stack">${s.shownPath?btn('next','Провести свой эксперимент'):btn('show-path','Показать путь воды','✧')}${btn('repeat','Налить воду ещё раз','↺','secondary-btn')}</div>`;
 break;
 case 3:
 html=startFrame('ВРЕМЯ ЭКСПЕРИМЕНТА','А если открыть только наполовину?','Передвигай ползунок. Смотри, как меняется число под названием «Скорость потока».')+
 `<div class="slider-card"><div class="slider-top"><span>НАСКОЛЬКО ОТКРЫТ КРАН?</span><strong id="sliderPercent">${Math.round(s.valve*100)}%</strong></div><input id="valveSlider" class="valve-slider" type="range" min="0" max="100" step="5" value="${Math.round(s.valve*100)}" aria-label="Открытие крана от нуля до ста процентов"><div class="slider-labels"><span>Закрыт</span><span>Наполовину</span><span>Открыт</span></div></div>`+
 `<div class="compare-row"><span>Открыт на 100%</span><div class="compare-track"><div class="compare-fill full" style="width:100%"></div></div><strong id="fullRateNum">${Math.round(fullRate())}</strong></div><div class="compare-row"><span>Сейчас</span><div class="compare-track"><div id="currentFlowBar" class="compare-fill" style="width:${Math.max(.2,s.valve*100)}%"></div></div><strong id="currentFlowNum">${Math.round(flowRate())}</strong></div>`+
 `<div class="small-goal"><strong>Задание:</strong> поставь кран на 40–60% и посмотри на поток несколько секунд.</div>`+
 (s.halfObserved?callout('Ты заметил: маленькое открытие → медленнее течёт вода. Это и есть управление потоком!'):'')+
 `<div class="button-stack">${s.halfObserved?btn('next','Проверить свою догадку'):btn('not-yet','Наблюдаю за водой…','◌','secondary-btn','disabled')}${btn('repeat','Повторить эксперимент','↺','secondary-btn')}</div>`;
 break;
 case 4:
 html=startFrame('ПОЧТИ НАУЧНЫЙ МЕТОД','А что будет, если открыть кран полностью?','Сейчас он открыт наполовину. Сначала предположи, что случится, если открыть его на 100%.')+
 `<div class="choice-list" role="group" aria-label="Выбери предположение">${['Вода потечёт быстрее','Скорость не изменится','Вода перестанет течь'].map((t,i)=>`<button class="choice ${s.prediction===i?'selected':''}" data-answer="${i}" aria-pressed="${s.prediction===i}" ${s.predictionChecked?'disabled':''}><span>${s.prediction===i?'✓':''}</span>${t}</button>`).join('')}</div>`+
 (s.predictionChecked?`<div class="quiz-result"><strong>${s.prediction===0?'Верно! Отличная догадка.':'Хорошая гипотеза! Давай сравним.'}</strong>Когда кран открыт шире, воде легче проходить через него. При одинаковом напоре её расход обычно больше. Посмотри на показания потока в лаборатории.</div>`:'')+
 `<div class="button-stack">${s.predictionChecked?btn('next','Теперь соберу сам!'):btn('check-prediction','Проверить догадку','↗','primary-btn',s.prediction===null?'disabled':'')}${btn('repeat','Начать проверку заново','↺','secondary-btn')}</div>`;
 break;
 case 5:{
 const placed=Object.values(s.parts).filter(Boolean).length;
 html=startFrame('ТВОЯ СОБСТВЕННАЯ МАСТЕРСКАЯ','Собери установку своими руками.','Выбери деталь и нажми на её место ниже. На компьютере можно также перетащить деталь мышью. Посмотри, как она появляется в 3D.')+
 `<div class="build-parts" aria-label="Доступные детали">${Object.entries(PARTS).map(([key,p])=>`<button type="button" class="part-chip ${s.parts[key]?'placed':s.selectedPart===key?'selected':''}" data-part="${key}" draggable="${!s.parts[key]}"><span class="part-art">${p.icon}</span>${p.name}</button>`).join('')}</div>`+
 `<div class="build-progress">СОБРАНО: ${placed} ИЗ 4 ДЕТАЛЕЙ</div>`+
 `<div class="build-slots" aria-label="Места установки деталей">${Object.entries(SLOTS).map(([key,slot])=>`<button type="button" class="assembly-slot ${s.parts[key]?'filled':''}" data-slot="${key}"><span>${slot.caption}</span><strong>${s.parts[key]?'✓ '+PARTS[key].name:'+ '+slot.name}</strong></button>`).join('')}</div>`+
 (s.feedback?`<div class="build-feedback" role="status">${s.feedback}</div>`:'')+
 (placed<4?'<p class="build-tip">Если ошибся — ничего страшного. Все детали можно переставлять.</p>':s.buildComplete?callout('Работает! Твоя установка доставила воду в бутылку. Ты сам её собрал!'):s.buildRun?'<p class="build-tip">Вода течёт. Дождись, когда в бутылке будет 160 мл.</p>':callout('Все части на месте! Теперь пора проверить устройство.'))+
 `<div class="button-stack">${s.buildComplete?btn('next','Получить первое достижение','✦'):placed===4?btn('start-build',s.buildRun?'Остановить / включить кран':'Запустить мою установку','↗'):btn('not-yet','Соедини все 4 детали','◌','secondary-btn','disabled')}${btn('repeat','Собрать заново','↺','secondary-btn')}</div>`;
 break;}
 case 6:
 html=startFrame('МИССИЯ ВЫПОЛНЕНА!','Ты построил свою первую машину!','Ты не просто нажимал кнопки. Ты увидел, как работает механизм, проверил идею и собрал установку из деталей.')+
 `<div class="certificate"><span class="certificate-burst">✹</span><strong>Первое инженерное открытие</strong><p>Вода и движение · Миссия 01</p></div>`+
 `<div class="skill-tags"><span class="skill-tag">✓ Управляю потоком</span><span class="skill-tag">✓ Проверяю гипотезы</span><span class="skill-tag">✓ Собираю устройства</span></div>`+
 `<div class="button-stack">${btn('restart','Пройти снова и улучшить результат','↺')}${btn('print','Распечатать мой результат','↗','secondary-btn')}</div>`;
 break;
 }
 el.guide.innerHTML=html;updateGauge();if(scene)scene.setState(state);}
function updateGauge(){const v=Math.round(state.valve*100);const slider=$('#valveSlider');if(slider&&document.activeElement!==slider)slider.value=v;const pct=$('#sliderPercent');if(pct)pct.textContent=v+'%';const b=$('#currentFlowBar');if(b)b.style.width=(Math.max(.5,100*flowRate()/Math.max(1,fullRate())))+'%';const num=$('#currentFlowNum');if(num)num.textContent=Math.round(flowRate());const full=$('#fullRateNum');if(full)full.textContent=Math.round(fullRate())}
function updateNumbers(){el.tank.textContent=Math.round(state.tank);el.flow.textContent=Math.round(flowRate());el.bottle.textContent=Math.round(state.bottle);let status='',sub='';if(state.step===5&&!canFlow()){status='Собери все детали';sub='Нужны бак, трубка, кран и бутылка'}else if(state.bottle>=499){status='Бутылка полная!';sub='Можно повторить опыт'}else if(flowRate()>1){status='Вода в движении';sub=`Кран открыт на ${Math.round(state.valve*100)}%`}else{status='Кран закрыт';sub='Вода ждёт твоей команды'}el.indicator.textContent=status;el.indicatorSub.textContent=sub;updateGauge()}
function tick(dt){if(!dt||dt>1)return;let dirty=false;const q=flowRate();if(q>0){let moved=Math.min(q*dt,state.tank,500-state.bottle);state.tank-=moved;state.bottle+=moved;dirty=true;if(state.bottle>=499.999||state.tank<=.01)state.valve=0;}
 if(state.step===1&&!state.observedOpen&&state.bottle>=120){state.observedOpen=true;renderGuide();announce('Молодец! Ты направил воду в бутылку. Теперь можно двигаться дальше.');save()}
 if(state.step===3&&!state.halfObserved){if(state.valve>=.4&&state.valve<=.6&&q>0)state.halfSeconds+=dt;else state.halfSeconds=0;if(state.halfSeconds>=1.5){state.halfObserved=true;renderGuide();announce('Эксперимент удался! Открытый наполовину кран пропускает меньше воды.');save()}}
 if(state.step===5&&state.buildRun&&!state.buildComplete&&state.bottle>=160){state.buildComplete=true;state.valve=0;renderGuide();announce('Потрясающе! Твоя установка работает. Ты собрал её самостоятельно.');save()}
 updateNumbers();if(dirty){savePending+=dt;if(savePending>1){savePending=0;save()}}}
function setPart(part,slot){if(state.step!==5)return;if(state.parts[part])return;if(part!==slot){state.feedback='Почти! Подумай, какую роль выполняет эта деталь. Например, кран нужен, чтобы управлять водой.';renderGuide();announce(state.feedback);return}state.parts[part]=true;state.selectedPart=null;state.feedback=`${PARTS[part].name} на месте! Отлично, найдём следующую часть.`;save();renderGuide();announce(state.feedback)}
function selectPart(part){if(state.step!==5||state.parts[part])return;state.selectedPart=part;state.feedback=`Выбрана деталь «${PARTS[part].name}». Теперь укажи место для неё.`;renderGuide();announce(state.feedback)}
function slotClick(slot){if(state.step!==5)return;if(state.parts[slot]){state.parts[slot]=false;state.selectedPart=slot;state.buildRun=false;state.buildComplete=false;state.valve=0;state.feedback=`${PARTS[slot].name} снята. Можешь установить её снова.`;save();renderGuide();return}if(!state.selectedPart){state.feedback='Сначала выбери одну из четырёх деталей выше.';renderGuide();return}setPart(state.selectedPart,slot)}
function repeat(){if(state.step===0){announce('Нажми «Поехали!», чтобы начать.');return}if(state.step===6){restart();return}enterStep(state.step);announce('Опыт начинается заново. Попробуй ещё раз!')}
function restart(){if(!window.confirm('Начать заново? Текущий прогресс этого гостевого урока будет сброшен.'))return;state=blankState();save();renderGuide();updateNumbers();announce('Урок начался заново. Добро пожаловать!')}
function handleAction(action){switch(action){case 'next':advance();break;case 'toggle-valve':openValve();break;case 'repeat':repeat();break;case 'restart':restart();break;case 'show-path':state.shownPath=true;save();renderGuide();announce('Путь воды подсвечен бирюзовым цветом.');break;case 'check-prediction':if(state.prediction===null)return;state.predictionChecked=true;freshWater(1);save();renderGuide();announce(state.prediction===0?'Верно! Поток воды стал быстрее.':'Теперь мы проверили на опыте: поток воды стал быстрее.');break;case 'start-build':if(Object.values(state.parts).every(Boolean)){if(state.bottle>=500){freshWater(0);state.buildComplete=false;}state.buildRun=true;state.valve=state.valve>.05?0:1;save();renderGuide();announce(state.valve?'Твоя установка запущена!':'Кран остановлен.')}break;case 'open-help':openHelp();break;case 'close-help':closeHelp();break;case 'speak':speak();break;case 'reset-camera':scene?.resetCamera();announce('Камера возвращена в начальное положение.');break;case 'orbit-left':scene?.orbit(-.24);break;case 'orbit-right':scene?.orbit(.24);break;case 'zoom-in':scene?.zoomBy(.89);break;case 'zoom-out':scene?.zoomBy(1.13);break;case 'print':printCertificate();break;default:break}}
function printCertificate(){const w=window.open('','_blank');if(!w){announce('Всплывающее окно заблокировано. Разреши его для печати.');return}w.document.write(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Моё открытие · BREAKTHROUGH</title><style>body{font-family:Arial,sans-serif;margin:8%;text-align:center;color:#1f4246}.frame{padding:60px 30px;border:8px double #60a599;border-radius:15px}h1{font-size:35px}.mark{font-size:60px;color:#d99a58}p{line-height:1.7}</style><div class="frame"><div class="mark">✹</div><h1>Первое инженерное открытие</h1><h2>Юный изобретатель</h2><p>Успешно завершил миссию «Вода и движение».<br>Управлял потоком воды, проверил гипотезу и собрал механизм из 4 деталей.</p><p>BREAKTHROUGH · Engineering Adventure</p></div><script>window.onload=()=>window.print()<\/script></html>`);w.document.close()}
function openHelp(){helpPrevFocus=document.activeElement;el.modal.hidden=false;$('.modal-close')?.focus();document.body.style.overflow='hidden'}
function closeHelp(){el.modal.hidden=true;document.body.style.overflow='';helpPrevFocus?.focus()}
function speak(){if(!('speechSynthesis' in window)){announce('Озвучивание недоступно в этом браузере. Весь текст задания написан справа.');return}window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(VOICES[state.step]);u.lang='ru-RU';u.rate=.90;u.pitch=1.1;window.speechSynthesis.speak(u);announce('Задание озвучивается.')}
function initEvents(){document.addEventListener('click',e=>{const a=e.target.closest('[data-action]');if(a){e.preventDefault();handleAction(a.dataset.action);return}const p=e.target.closest('[data-part]');if(p){selectPart(p.dataset.part);return}const slot=e.target.closest('[data-slot]');if(slot){slotClick(slot.dataset.slot);return}const answer=e.target.closest('[data-answer]');if(answer&&state.step===4&&!state.predictionChecked){state.prediction=Number(answer.dataset.answer);save();renderGuide();announce('Гипотеза выбрана. Теперь можно её проверить.')}});
 el.guide.addEventListener('input',e=>{if(e.target?.id==='valveSlider'&&state.step===3){state.valve=Number(e.target.value)/100;state.halfSeconds=0;updateNumbers();save()}});
 el.guide.addEventListener('dragstart',e=>{const chip=e.target.closest('[data-part]');if(!chip||state.parts[chip.dataset.part]){e.preventDefault();return}e.dataTransfer.setData('text/plain',chip.dataset.part);e.dataTransfer.effectAllowed='move'});
 el.guide.addEventListener('dragover',e=>{if(e.target.closest('[data-slot]'))e.preventDefault()});
 el.guide.addEventListener('drop',e=>{const slot=e.target.closest('[data-slot]');if(!slot)return;e.preventDefault();const part=e.dataTransfer.getData('text/plain');if(Object.keys(PARTS).includes(part))setPart(part,slot.dataset.slot)});
 el.hotspot.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();openValve()});
 el.modal.addEventListener('click',e=>{if(e.target===el.modal)closeHelp()});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!el.modal.hidden)closeHelp();if(e.key==='Tab'&&!el.modal.hidden){const focusable=Array.from(el.modal.querySelectorAll('button:not(:disabled)'));let i=focusable.indexOf(document.activeElement);if(e.shiftKey&&i===0){e.preventDefault();focusable[focusable.length-1].focus()}else if(!e.shiftKey&&i===focusable.length-1){e.preventDefault();focusable[0].focus()}}});
 }
function start(){load();try{scene=new window.Breakthrough3D(el.canvas,{onValveToggle:openValve});scene.setState(state)}catch(error){console.info('WebGL недоступен, включен резервный Canvas-рендерер:',error.message);const chip=document.querySelector('.header-chip');if(chip)chip.textContent='ПОВОРОТНАЯ МОДЕЛЬ · 2D';el.canvas.setAttribute('aria-label','Интерактивная изометрическая модель водяной установки. Кран управляется кнопкой или нажатием на модель.');try{scene=new window.BreakthroughFallback(el.canvas,{onValveToggle:openValve});scene.setState(state)}catch(fallbackError){console.error('Canvas renderer failed:',fallbackError);el.fallback.hidden=false;el.hotspot.hidden=true;}}initEvents();renderGuide();updateNumbers();if(state.step===5&&state.buildComplete)state.valve=0;requestAnimationFrame(frame)}
function frame(t){const dt=lastTick?Math.min(.05,(t-lastTick)/1000):0;lastTick=t;tick(dt);scene?.render(window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:t/1000);requestAnimationFrame(frame)}
window.breakthroughDebug={getState:()=>JSON.parse(JSON.stringify(state)),getFlow:()=>flowRate(),getWebGL:()=>!!scene&&(scene instanceof window.Breakthrough3D)};
start();
})();