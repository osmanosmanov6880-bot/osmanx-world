'use strict';
const $=(sel)=>document.querySelector(sel);
const taskKey='osmanx-desktop-tasks-v1';
const state={projects:[],tasks:[],view:'portfolio',filter:'Все',query:''};
function toast(message,bad=false){const el=$('#toast');el.textContent=message;el.className=bad?'toast error':'toast';el.style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.style.display='none',3800)}
function validateSaved(value){if(!Array.isArray(value))return [];return value.filter(t=>t&&typeof t.title==='string'&&t.title.length<=180&&typeof t.id==='string'&&t.id.length<=80).slice(0,500).map(t=>({
 id:t.id,title:t.title,projectId:t.projectId,done:t.done===true,createdAt:t.createdAt||''}));}
function save(){localStorage.setItem(taskKey,JSON.stringify(state.tasks));renderTasks();$('#nav-count').textContent=state.tasks.filter(t=>!t.done).length}
function node(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}
function switchView(next){state.view=next;document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===next));
 document.querySelectorAll('.view').forEach(s=>{const active=s.id===next;s.classList.toggle('active',active);s.hidden=!active;});
 $('#crumb').textContent=({portfolio:'ПОРТФЕЛЬ',tasks:'МОИ ЗАДАЧИ',about:'О ПРИЛОЖЕНИИ'})[next];}
function renderProjects(){
 const list=$('#project-list');list.replaceChildren();
 const filtered=state.projects.filter(p=>(state.filter==='Все'||p.category===state.filter)&&
 [p.name,p.label,p.description].join(' ').toLocaleLowerCase('ru').includes(state.query.toLocaleLowerCase('ru')));
 if(!filtered.length){list.append(node('div','empty','По запросу ничего не найдено.'));return}
 for(const p of filtered){
  const card=node('article','project-card');
  const head=node('div','card-head');head.append(node('span','card-cat',p.category),node('span','card-status',p.status));card.append(head);
  card.append(node('h2','',p.name),node('div','card-label',p.label),node('p','',p.description));
  const bottom=node('div','card-bottom');bottom.append(node('small','',p.access));
  const button=node('button','open-button',p.canOpen?'Открыть ↗':'По запросу');button.disabled=!p.canOpen;
  button.addEventListener('click',async()=>{try{const ok=await window.osmanx.openProject(p.id);if(!ok)toast('Ссылка пока не доступна',true)}catch(e){toast('Не удалось открыть браузер',true)}});
  bottom.append(button);card.append(bottom);list.append(card);
 }
}
function renderTasks(){const list=$('#task-list');list.replaceChildren();$('#task-total').textContent=state.tasks.length+' задач';
 if(!state.tasks.length){list.append(node('div','empty','Задач пока нет. Добавьте первое действие выше.'));return}
 for(const t of [...state.tasks].sort((a,b)=>Number(a.done)-Number(b.done))){
  const row=node('div','task-row'+(t.done?' done':''));
  const box=node('input');box.type='checkbox';box.checked=t.done;box.setAttribute('aria-label','Выполнена: '+t.title);
  box.addEventListener('change',()=>{t.done=box.checked;save()});
  const name=node('div','task-title',t.title);
  const project=state.projects.find(p=>p.id===t.projectId);
  const belong=node('span','task-belong',project?.name||'Общее');
  const remove=node('button','delete-task','×');remove.title='Удалить задачу';remove.setAttribute('aria-label','Удалить '+t.title);
  remove.addEventListener('click',()=>{state.tasks=state.tasks.filter(x=>x.id!==t.id);save()});
  row.append(box,name,belong,remove);list.append(row);
 }}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{state.filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));renderProjects()}));
$('#search').addEventListener('input',e=>{state.query=e.target.value.trim();renderProjects()});
$('#task-form').addEventListener('submit',e=>{
 e.preventDefault();const input=$('#task-title');const title=input.value.trim();if(!title||title.length>180)return;
 if(state.tasks.length>=500){toast('Лимит 500 задач',true);return}
 state.tasks.unshift({id:crypto.randomUUID(),title,projectId:$('#task-project').value,done:false,createdAt:new Date().toISOString()});
 input.value='';save();toast('Задача добавлена');
});
$('#task-export').addEventListener('click',async()=>{try{const out=await window.osmanx.exportTasks(state.tasks);if(!out.cancelled)toast('Экспортировано '+out.count+' задач')}catch(e){toast('Ошибка экспорта: '+e.message,true)}});
$('#task-import').addEventListener('click',async()=>{try{const out=await window.osmanx.importTasks();if(out.cancelled)return;
 if(!confirm('Заменить текущие задачи данными из файла?'))return;state.tasks=validateSaved(out.tasks);save();toast('Импортировано '+state.tasks.length+' задач')}catch(e){toast('Не удалось импортировать JSON: '+e.message,true)}});
$('#open-site').addEventListener('click',()=>window.osmanx.openSite());$('#about-site').addEventListener('click',()=>window.osmanx.openSite());
(async()=>{
 try{state.projects=await window.osmanx.projects();const raw=localStorage.getItem(taskKey);
   if(raw)state.tasks=validateSaved(JSON.parse(raw));
   const select=$('#task-project');select.append(node('option','', 'Общее'));select.lastChild.value='general';
   for(const p of state.projects){const o=node('option','',p.name);o.value=p.id;select.append(o)}
   const version=await window.osmanx.version();$('#version').textContent='v'+version+' · WINDOWS';$('#app-version').textContent='v'+version;
   renderProjects();save();renderTasks();
 }catch(e){toast('Ошибка инициализации: '+e.message,true)}
})();
