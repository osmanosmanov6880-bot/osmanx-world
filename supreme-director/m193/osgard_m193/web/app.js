'use strict';
// No third-party assets, storage of credentials, or production effects.
const state = {token:null, identity:null, page:'overview', filter:'', generation:0,
  overview:null, clients:[], deals:[], activities:[], labels:{}, modal:null};
const $ = id => document.getElementById(id);
const tr = key => state.labels[key] || key;
const make = (tag, cls='', value=null) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (value !== null) node.textContent = String(value);
  return node;
};
const add = (parent,...children) => {parent.append(...children);return parent;};
const rub = minor => new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2}).format(minor/100);
const moneyInput = minor => (minor/100).toFixed(2);
const stageName = name => tr(name);
const stageTransitions = {new:['new','qualified','lost'], qualified:['qualified','proposal','lost'],
 proposal:['proposal','won','lost'],won:['won'],lost:['lost']};
let toastTimer;

function notice(message) {
  const node = $('toast'); node.textContent=message;node.hidden=false;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>{node.hidden=true;},3200);
}
function staticTranslations() {
  document.querySelectorAll('[data-t]').forEach(el=>{el.textContent=tr(el.dataset.t);});
  $('credential').placeholder=tr('tokenPlaceholder');
  $('fieldName').placeholder=tr('namePlaceholder');
  $('fieldContact').placeholder=tr('contactPlaceholder');
  $('fieldTitle').placeholder=tr('dealPlaceholder');
  $('fieldDetails').placeholder=tr('detailsPlaceholder');
}
async function api(op,payload={},write=false,token=state.token) {
  if (!token) throw new Error(tr('loginError'));
  const key = write ? 'm193-'+crypto.randomUUID() : null;
  const response = await fetch('/v1/execute',{
    method:'POST',mode:'same-origin',credentials:'omit',cache:'no-store',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
    body:JSON.stringify({operation:op,payload,idempotency_key:key})
  });
  let data;
  try {data=await response.json();} catch (_) {throw new Error(tr('refreshError'));}
  if (!response.ok) {
    const err = new Error(response.status===409 ? tr('versionConflict') : (data.message||data.error||tr('failed')));
    err.status=response.status;
    throw err;
  }
  return data.result;
}
function canEdit() {return !!state.identity && state.identity.role!=='viewer';}
function logout() {
  state.generation++;
  state.token=null;state.identity=null;state.overview=null;
  state.clients=[];state.deals=[];state.activities=[];
  $('credential').value=''; $('app').hidden=true; $('login').hidden=false;
  if ($('modal').open) $('modal').close();
}
async function login(event) {
  event.preventDefault();
  const credential=$('credential').value.trim();
  const button=$('loginForm').querySelector('button');
  button.disabled=true; button.textContent=tr('loggingIn');$('loginError').hidden=true;
  try {
    const identity=await api('titan.session.get',{},false,credential);
    state.token=credential;state.identity=identity;
    $('credential').value='';$('login').hidden=true;$('app').hidden=false;
    $('accountInfo').replaceChildren(add(make('b','',identity.actor),make('span','',identity.role)));
    await reload();
    setPage('overview');
  } catch (e) {
    logout();$('loginError').hidden=false;$('loginError').textContent=e.message||tr('loginError');
  } finally {button.disabled=false;button.textContent=tr('connect');}
}
async function reload() {
  if (!state.token) return;
  const generation=++state.generation;
  try {
    const [overview,customers,deals,activities]=await Promise.all([
      api('commerce.crm.overview'),api('commerce.crm.customers.list'),
      api('commerce.crm.deals.list'),api('commerce.crm.activities.list')
    ]);
    if (generation!==state.generation) return;
    state.overview=overview;state.clients=customers.customers;
    state.deals=deals.deals;state.activities=activities.activities;
    render();
  } catch(e) {
    if (generation!==state.generation) return;
    if (e.status===403) {logout();notice(tr('loginError'));return;}
    notice(e.message||tr('refreshError'));
  }
}
function setPage(page) {
  if (!['overview','clients','deals','activities','other'].includes(page))return;
  state.page=page;state.filter='';
  document.querySelectorAll('[data-page]').forEach(btn=>{
    const active=btn.dataset.page===page;
    btn.classList.toggle('active',active);btn.setAttribute('aria-current',active?'page':'false');
  });
  $('pageTitle').textContent=tr(page);
  render();
  if (page==='other') loadModules();
}
function pageHeading(title,subtitle,action=null) {
  const root=make('div','page-head');const texts=make('div');
  add(texts,make('div','eyebrow',tr('section')),make('h1','',title));
  if (subtitle) texts.appendChild(make('p','',subtitle));
  root.appendChild(texts);
  if (action && canEdit()) {
    const button=make('button','primary',tr(action.label)); button.type='button';
    button.onclick=()=>openModal(action.mode);root.appendChild(button);
  }
  return root;
}
function summaryCard(label,num,note='') {
  const card=make('div','stat');add(card,make('span','',label),make('strong','',num));
  if (note)card.appendChild(make('small','',note));
  return card;
}
function panel(title,sub='') {
  const outer=make('section','panel');const head=make('div','panel-head');const txt=make('div');
  add(txt,make('h2','',title));if(sub)txt.appendChild(make('p','',sub));
  head.appendChild(txt);outer.appendChild(head);return outer;
}
function empty(root,msg){root.appendChild(make('p','empty',msg));return root;}
function renderOverview(root) {
  root.appendChild(pageHeading(tr('mainTitle'),tr('mainSubtitle')));
  const s=state.overview;
  if (!s){root.appendChild(make('p','spinner',tr('loading')));return;}
  const stats=make('div','stats');
  add(stats,summaryCard(tr('clientsCount'),s.customers),summaryCard(tr('dealsCount'),s.deals),
    summaryCard(tr('openActivities'),s.open_activities),summaryCard(tr('overdueActivities'),s.overdue_activities));
  root.appendChild(stats);
  const pipe=panel(tr('pipelineTitle'),tr('pipelineSubtitle'));
  const stages=make('div','pipeline');
  const max=Math.max(1,...Object.values(s.pipeline).map(x=>x.amount_minor));
  for (const name of ['new','qualified','proposal','won','lost']) {
    const item=s.pipeline[name];const stage=make('div','stage');
    add(stage,make('div','name',stageName(name)),make('div','money',rub(item.amount_minor)),
      make('div','count',`${item.count} ${tr('deals')}`));
    const bar=make('div','bar');const fill=make('span');fill.style.width=(item.amount_minor*100/max)+'%';
    bar.appendChild(fill);stage.appendChild(bar);stages.appendChild(stage);
  }
  pipe.appendChild(stages);root.appendChild(pipe);
  const recent=panel(tr('recentActivities'));
  renderActivitiesList(recent,state.activities.slice(0,5),false);
  root.appendChild(recent);
}
function record(primary,secondary,tag='') {
  const row=make('div','record');const main=make('div');
  add(main,make('strong','',primary),make('small','',secondary));row.appendChild(main);
  const controls=make('div','record-actions');if(tag)controls.appendChild(make('span','tag '+tag,tag));
  row.appendChild(controls);return {row,controls};
}
function editButton(action,id) {
  const b=make('button','secondary',tr('update'));b.type='button';
  b.onclick=()=>openModal(action,id);return b;
}
function filterBar(root) {
  const tools=make('div','toolbar');const search=make('input');
  search.type='search';search.placeholder=tr('search');search.setAttribute('aria-label',tr('search'));
  search.value=state.filter;search.oninput=e=>{state.filter=e.target.value;renderListOnly();};
  tools.appendChild(search);root.appendChild(tools);
}
function normalizedSearch(item) {return Object.values(item).map(x=>x==null?'':String(x)).join(' ').toLocaleLowerCase('ru');}
function renderListOnly(){render();const input=$('content').querySelector('.toolbar input');if(input){input.focus();input.setSelectionRange(input.value.length,input.value.length);}}
function renderCustomers(root){
  root.appendChild(pageHeading(tr('latestClients'),tr('mainSubtitle'),{label:'newClient',mode:'newCustomer'}));
  filterBar(root);const list=make('div','records');const needle=state.filter.toLocaleLowerCase('ru');
  const rows=state.clients.filter(x=>normalizedSearch(x).includes(needle));
  if (!rows.length)empty(list,tr('noClients'));
  for (const c of rows) {
    const {row,controls}=record(c.name,c.contact+'   ·   '+tr('versions')+' '+c.version);
    if (canEdit())controls.appendChild(editButton('editCustomer',c.id));
    list.appendChild(row);
  }
  root.appendChild(list);
}
function renderDeals(root){
  root.appendChild(pageHeading(tr('latestDeals'),tr('pipelineSubtitle'),{label:'newDeal',mode:'newDeal'}));
  filterBar(root);const list=make('div','records');const needle=state.filter.toLocaleLowerCase('ru');
  const rows=state.deals.filter(x=>normalizedSearch(x).includes(needle));
  if (!rows.length)empty(list,tr('noDeals'));
  for (const d of rows) {
    const {row,controls}=record(d.title+' · '+rub(d.amount_minor),d.customer_name+' · '+tr('versions')+' '+d.version);
    controls.appendChild(make('span','tag '+d.stage,stageName(d.stage)));
    if (canEdit()) controls.appendChild(editButton('editDeal',d.id));
    list.appendChild(row);
  }
  root.appendChild(list);
}
function formatDate(sec) {return sec==null?'—':new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short'}).format(sec*1000);}
function renderActivitiesList(root,activities,includeActions=true){
  const list=make('div','records');
  if (!activities.length) empty(list,tr('noActivities'));
  for (const a of activities) {
    const info=a.customer_name+' · '+tr(a.kind)+' · '+(a.due_at?formatDate(a.due_at):tr('noDeal'));
    const {row,controls}=record(a.details,info);
    const overdue=a.status==='open'&&a.due_at&&a.due_at<Math.floor(Date.now()/1000);
    controls.appendChild(make('span','tag '+(overdue?'overdue':a.status),tr(a.status)));
    if (includeActions&&canEdit()&&a.status==='open') {
      const btn=make('button','secondary',tr('complete'));btn.type='button';
      btn.onclick=async()=>{
        btn.disabled=true;
        try {await api('commerce.crm.activities.complete',
          {activity_id:a.id,expected_version:a.version},true);notice(tr('completed'));await reload();}
        catch(e){notice(e.message||tr('failed'));await reload();}
        finally{btn.disabled=false;}
      };
      controls.appendChild(btn);
    }
    list.appendChild(row);
  }
  root.appendChild(list);
}
function renderActivities(root){
  root.appendChild(pageHeading(tr('activities'),tr('recentActivities'),{label:'newActivity',mode:'newActivity'}));
  renderActivitiesList(root,state.activities,true);
}
async function loadModules(){
  const generation=state.generation;
  const ops=['titan.tasks.list','nexus.decisions.list','experience.bookings.list'];
  if(state.identity?.role==='owner')ops.push('orbital.emulator.list');
  const results=await Promise.allSettled(ops.map(op=>api(op)));
  if(generation!==state.generation||state.page!=='other')return;
  const list=$('moduleCards');if(!list)return;
  const data={};results.forEach((r,i)=>{if(r.status==='fulfilled')data[ops[i]]=r.value;});
  const cells=[
    ['titan',data['titan.tasks.list']?.tasks?.length],
    ['nexus',data['nexus.decisions.list']?.decisions?.length],
    ['experience',data['experience.bookings.list']?.bookings?.length],
    ['genesis',null],
    ['orbital',data['orbital.emulator.list']?.commands?.length]
  ];
  list.replaceChildren();
  cells.forEach(([key,count])=>{
    const div=make('div','module-card');add(div,make('strong','',tr(key)),make('p','',key==='orbital'?tr('simulatorWarning'):tr('moduleNote')),
      make('div','count',count===undefined||count===null?tr('notAvailable'):count));
    list.appendChild(div);
  });
}
function renderModules(root){
  root.appendChild(pageHeading(tr('modulesTitle'),tr('modulesSub')));
  const list=make('div','modules');list.id='moduleCards';root.appendChild(list);
  // Modules load on demand; no implied live integrations.
}
function render(){
  if(!$('app')||$('app').hidden)return;
  const root=$('content');root.replaceChildren();
  ({overview:renderOverview,clients:renderCustomers,deals:renderDeals,
    activities:renderActivities,other:renderModules}[state.page]||renderOverview)(root);
}
function showFields(enabled){
  document.querySelectorAll('[data-field]').forEach(group=>{
    const isOn=enabled.includes(group.dataset.field);
    group.hidden=!isOn;
    const input=group.querySelector('input,select,textarea');input.disabled=!isOn;input.required=false;
    input.value='';
  });
}
function putOptions(select,values,labeler,placeholder=null){
  select.replaceChildren();
  if(placeholder!==null){const o=make('option','',placeholder);o.value='';select.appendChild(o);}
  values.forEach(item=>{
    const o=make('option','',labeler(item));o.value=typeof item==='string'?item:item.id;
    select.appendChild(o);
  });
}
function populateDeals(){
  const customer=$('fieldCustomer').value;
  putOptions($('fieldDeal'),state.deals.filter(d=>d.customer_id===customer),d=>d.title,tr('noDeal'));
}
function openModal(mode,id=null){
  if(!canEdit()){notice(tr('readOnly'));return;}
  state.modal={mode,id};
  const titles={newCustomer:'newClient',editCustomer:'clientEdit',newDeal:'newDeal',
    editDeal:'dealEdit',newActivity:'newActivity'};
  $('modalTitle').textContent=tr(titles[mode]);$('modalError').hidden=true;
  const config={
    newCustomer:['name','contact'],editCustomer:['name','contact'],
    newDeal:['customer','title','amount','stage'],editDeal:['title','amount','stage'],
    newActivity:['customer','deal','kind','details','due']
  };
  showFields(config[mode]);
  const required={newCustomer:['name','contact'],editCustomer:['name','contact'],
    newDeal:['customer','title','amount','stage'],editDeal:['title','amount','stage'],
    newActivity:['customer','kind','details']};
  required[mode].forEach(field=>document.querySelector(`[data-field="${field}"]`).querySelector('input,select,textarea').required=true);
  if(mode==='editCustomer'){
    const row=state.clients.find(x=>x.id===id);if(!row)return;
    $('fieldName').value=row.name;$('fieldContact').value=row.contact;
  }
  if(mode==='editDeal'){
    const row=state.deals.find(x=>x.id===id);if(!row)return;
    $('fieldTitle').value=row.title;$('fieldAmount').value=moneyInput(row.amount_minor);
    putOptions($('fieldStage'),stageTransitions[row.stage],x=>tr(x));$('fieldStage').value=row.stage;
  }
  if(mode==='newDeal'){
    putOptions($('fieldCustomer'),state.clients,c=>c.name,tr('noCustomer'));
    putOptions($('fieldStage'),['new'],x=>tr(x));$('fieldAmount').value='0';
  }
  if(mode==='newActivity'){
    putOptions($('fieldCustomer'),state.clients,c=>c.name,tr('noCustomer'));
    putOptions($('fieldKind'),['call','email','meeting','note'],x=>tr(x));
    $('fieldCustomer').onchange=populateDeals;populateDeals();
  }
  $('submitModal').textContent=tr(mode.startsWith('new')?'create':'save');
  $('modal').showModal();
}
function parseMoney(input){
  if(!/^\d{1,10}(?:[.,]\d{1,2})?$/.test(input))throw new Error(tr('invalidAmount'));
  const [whole,dec='']=input.replace(',','.').split('.');
  const amount=Number(whole)*100+Number(dec.padEnd(2,'0'));
  if(!Number.isSafeInteger(amount)||amount>1e12)throw new Error(tr('invalidAmount'));
  return amount;
}
async function submitEditor(event){
  event.preventDefault();if(!state.modal)return;
  const {mode,id}=state.modal;const button=$('submitModal');button.disabled=true;
  $('modalError').hidden=true;
  try{
    let op,p;
    if(mode==='newCustomer'){
      op='commerce.customers.create';p={name:$('fieldName').value,contact:$('fieldContact').value};
    } else if(mode==='editCustomer'){
      const row=state.clients.find(x=>x.id===id);if(!row)throw Error(tr('failed'));
      op='commerce.crm.customers.update';p={customer_id:row.id,expected_version:row.version,
        name:$('fieldName').value,contact:$('fieldContact').value};
    } else if(mode==='newDeal'){
      op='commerce.deals.create';p={customer_id:$('fieldCustomer').value,
        title:$('fieldTitle').value,amount_minor:parseMoney($('fieldAmount').value),stage:'new'};
    } else if(mode==='editDeal'){
      const row=state.deals.find(x=>x.id===id);if(!row)throw Error(tr('failed'));
      op='commerce.crm.deals.update';p={deal_id:row.id,expected_version:row.version,
        title:$('fieldTitle').value,amount_minor:parseMoney($('fieldAmount').value),stage:$('fieldStage').value};
    } else if(mode==='newActivity'){
      op='commerce.crm.activities.create';p={customer_id:$('fieldCustomer').value,
        kind:$('fieldKind').value,details:$('fieldDetails').value};
      if($('fieldDeal').value)p.deal_id=$('fieldDeal').value;
      if($('fieldDue').value)p.due_at=Math.floor(new Date($('fieldDue').value).getTime()/1000);
    } else throw Error(tr('failed'));
    await api(op,p,true);
    $('modal').close();state.modal=null;notice(tr(mode.startsWith('new')?'created':'saved'));
    await reload();
  }catch(e){$('modalError').hidden=false;$('modalError').textContent=e.message||tr('failed');
    if(e.status===409)await reload();
  }finally{button.disabled=false;}
}
async function start(){
  try{
    const res=await fetch('/studio/ru.json',{mode:'same-origin',cache:'no-store'});
    if(res.ok)state.labels=await res.json();
  }catch(_){/* Static English keys remain as a safe last resort. */}
  staticTranslations();
  $('loginForm').addEventListener('submit',login);
  $('logout').addEventListener('click',logout);
  $('refresh').addEventListener('click',reload);
  document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>setPage(b.dataset.page)));
  $('closeModal').onclick=$('cancelModal').onclick=()=>$('modal').close();
  $('editorForm').addEventListener('submit',submitEditor);
  $('modal').addEventListener('close',()=>{state.modal=null;});
}
start();
