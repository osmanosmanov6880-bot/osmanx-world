'use strict';
// No third-party assets, storage of credentials, or production effects.
const state = {token:null, identity:null, page:'overview', filter:'', generation:0,
  overview:null, clients:[], deals:[], activities:[], labels:{}, modal:null, ops:null, team:null};
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
  state.clients=[];state.deals=[];state.activities=[];state.ops=null;state.team=null;opsImport=null;
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
    if(state.page==='operations')loadOperations();
    if(state.page==='team')loadTeam();
  } catch(e) {
    if (generation!==state.generation) return;
    if (e.status===403) {logout();notice(tr('loginError'));return;}
    notice(e.message||tr('refreshError'));
  }
}
function setPage(page) {
  if (!['overview','clients','deals','activities','operations','team','other'].includes(page))return;
  state.page=page;state.filter='';
  document.querySelectorAll('[data-page]').forEach(btn=>{
    const active=btn.dataset.page===page;
    btn.classList.toggle('active',active);btn.setAttribute('aria-current',active?'page':'false');
  });
  $('pageTitle').textContent=tr(page);
  render();
  if (page==='other') loadModules();
  if (page==='operations') loadOperations();
  if (page==='team') loadTeam();
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

// M194: all numbers and CSV rows are fetched from the authenticated local API.
// Never place credentials or imported contacts in localStorage, cookies or URL.
let opsImport = null;
let selectedFollowups = new Set();
async function loadOperations() {
  if(!state.token || state.page!=='operations') return;
  const marker=state.generation, token=state.token;
  try {
    const promises=[api('commerce.crm.pipeline.metrics'),
      api('commerce.crm.followups.queue',{days:30,limit:200,include_unscheduled:true})];
    if(state.identity.role==='owner') promises.push(api('titan.audit.list'));
    const result=await Promise.all(promises);
    if(marker!==state.generation || token!==state.token || state.page!=='operations') return;
    state.ops={metrics:result[0],queue:result[1],audit:result[2]?.audit||[]};
    render();
  }catch(e){notice(e.message||tr('refreshError'));}
}
function opsButton(label,click,cls='secondary') {
  const b=make('button',cls,label);b.type='button';b.onclick=click;return b;
}
function renderOperations(root) {
  root.appendChild(pageHeading(tr('opsHeading'),tr('opsSubtitle')));
  const data=state.ops;
  const top=make('div','ops-topbar');
  top.appendChild(opsButton(tr('refreshOps'),loadOperations));
  if(state.identity.role==='owner') top.appendChild(opsButton(tr('exportClients'),exportCsv));
  root.appendChild(top);
  if(!data){root.appendChild(make('p','spinner',tr('loading')));return;}
  const stats=make('div','stats');
  add(stats,summaryCard(tr('activePipeline'),rub(data.metrics.active_amount_minor)),
    summaryCard(tr('wonRevenue'),rub(data.metrics.won_amount_minor)),
    summaryCard(tr('winRate'),data.metrics.win_rate_percent===null?'—':data.metrics.win_rate_percent+'%'),
    summaryCard(tr('overdue'),data.queue.counts.overdue));
  root.appendChild(stats);
  const info=make('p','small-muted',tr('noForecast'));root.appendChild(info);
  const importPanel=panel(tr('importClients'),tr('importHelp'));
  if(canEdit()) {
    const form=make('div','ops-import');
    const source=make('textarea','ops-csv');source.id='opsCsv';source.rows=5;
    source.placeholder='name,contact\nКлиент,contact@example.com';
    source.setAttribute('aria-label',tr('importArea'));
    const file=make('input');file.type='file';file.accept='.csv,text/csv';
    file.setAttribute('aria-label',tr('importClients'));
    file.onchange=async()=>{
      const f=file.files?.[0];if(!f)return;
      if(f.size>65536){notice(tr('importInvalid'));return;}
      source.value=await f.text();opsImport=null;
      const note=$('previewResult');if(note)note.textContent='';
    };
    source.oninput=()=>{opsImport=null;const note=$('previewResult');if(note)note.textContent='';};
    const preview=opsButton(tr('previewImport'),()=>previewCsv(source.value),'primary');
    const commit=opsButton(tr('commitImport'),commitCsv,'primary');commit.id='commitImport';commit.hidden=true;
    const result=make('p','ops-preview');result.id='previewResult';
    add(form,file,source,preview,commit,result);importPanel.appendChild(form);
  }else empty(importPanel,tr('readOnly'));
  root.appendChild(importPanel);
  const queue=panel(tr('followups'),tr('followupsSubtitle'));
  const totals=make('div','ops-totals');
  for(const [k,val] of Object.entries({overdue:data.queue.counts.overdue,
    upcoming:data.queue.counts.upcoming,unscheduled:data.queue.counts.unscheduled})){
    totals.appendChild(make('span','mini-stat',tr(k)+': '+val));
  }
  queue.appendChild(totals);
  if(canEdit()&&data.queue.items.length){
    queue.appendChild(opsButton(tr('bulkComplete'),bulkCompleteSelected));
  }
  const list=make('div','records');
  if(!data.queue.items.length)empty(list,tr('emptyOps'));
  const currentIds=new Set(data.queue.items.map(x=>x.id));
  selectedFollowups=new Set([...selectedFollowups].filter(id=>currentIds.has(id)));
  for(const a of data.queue.items){
    const recordWrap=make('div','ops-activity');
    if(canEdit()){
      const check=make('input');check.type='checkbox';check.checked=selectedFollowups.has(a.id);
      check.setAttribute('aria-label',tr('complete')+': '+a.details);
      check.onchange=()=>check.checked?selectedFollowups.add(a.id):selectedFollowups.delete(a.id);
      recordWrap.appendChild(check);
    }
    const content=make('div','ops-activity-content');
    const row=record(a.details,a.customer_name+' · '+tr(a.kind)+' · '+(a.due_at?formatDate(a.due_at):tr('unscheduled')));
    row.controls.appendChild(make('span','tag '+a.urgency,tr(a.urgency)));
    if(canEdit()){
      const resched=opsButton(tr('reschedule'),()=>showReschedule(content,a));
      row.controls.appendChild(resched);
    }
    content.appendChild(row.row);recordWrap.appendChild(content);list.appendChild(recordWrap);
  }
  queue.appendChild(list);root.appendChild(queue);
  if(state.identity.role==='owner'){
    const history=panel(tr('auditTrail'),tr('auditOwnerOnly'));
    const events=make('div','records');
    if(!data.audit.length)empty(events,tr('emptyOps'));
    for(const a of data.audit.slice(0,12)){
      events.appendChild(record(a.operation,a.actor+' · '+formatDate(a.recorded_at)).row);
    }
    history.appendChild(events);root.appendChild(history);
  }
}
async function previewCsv(raw){
  const output=$('previewResult');const button=$('commitImport');
  if(!output||!button)return;
  button.hidden=true;opsImport=null;
  try{
    const result=await api('commerce.crm.import.preview',{csv:raw});
    output.textContent=tr('importTotal')+': '+result.rows+' · '+tr('importNew')+': '+result.to_create+
      ' · '+tr('importExisting')+': '+result.already_exists;
    if(result.can_commit){opsImport={raw,sha:result.preview_sha256};button.hidden=false;}
  }catch(e){output.textContent=e.message||tr('importInvalid');}
}
async function commitCsv(){
  const item=opsImport;if(!item)return;
  const btn=$('commitImport');if(btn)btn.disabled=true;
  try{
    const result=await api('commerce.crm.import.commit',
      {csv:item.raw,preview_sha256:item.sha},true);
    opsImport=null;selectedFollowups.clear();notice(tr('importSuccess')+': '+result.created);
    await reload();
  }catch(e){opsImport=null;notice(e.message||tr('importStale'));await loadOperations();}
  finally{if(btn)btn.disabled=false;}
}
async function exportCsv(){
  try{
    const result=await api('commerce.crm.export.csv');
    const blob=new Blob(['\ufeff'+result.csv],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const a=make('a');a.href=url;a.download='OSGARD_CLIENTS_LOCAL.csv';
    document.body.appendChild(a);a.click();a.remove();
    window.setTimeout(()=>URL.revokeObjectURL(url),1000);
    notice(tr('csvNote'));
  }catch(e){notice(e.message||tr('failed'));}
}
async function bulkCompleteSelected(){
  const items=state.ops?.queue?.items.filter(x=>selectedFollowups.has(x.id))||[];
  if(!items.length){notice(tr('selectionEmpty'));return;}
  try{
    await api('commerce.crm.followups.bulk_complete',
      {activities:items.map(x=>({activity_id:x.id,expected_version:x.version}))},true);
    selectedFollowups.clear();notice(tr('completed'));await reload();
  }catch(e){notice(e.message||tr('versionConflict'));await reload();}
}
function showReschedule(content,item){
  content.querySelector('.due-form')?.remove();
  const form=make('form','due-form');
  const input=make('input');input.type='datetime-local';input.setAttribute('aria-label',tr('due'));
  if(item.due_at){const date=new Date(item.due_at*1000);const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);
    input.value=local.toISOString().slice(0,16);}
  const btn=make('button','primary',tr('saveDue'));btn.type='submit';
  form.append(input,btn);
  form.onsubmit=async e=>{
    e.preventDefault();btn.disabled=true;
    const due=input.value?Math.floor(new Date(input.value).getTime()/1000):null;
    if(input.value&&!Number.isFinite(due)){notice(tr('dueDateInvalid'));btn.disabled=false;return;}
    try{await api('commerce.crm.followups.reschedule',
      {activity_id:item.id,expected_version:item.version,due_at:due},true);
      notice(tr('saved'));await reload();}
    catch(err){notice(err.message||tr('versionConflict'));await reload();}
    finally{btn.disabled=false;}
  };
  content.appendChild(form);input.focus();
}

function render(){
  if(!$('app')||$('app').hidden)return;
  const root=$('content');root.replaceChildren();
  ({overview:renderOverview,clients:renderCustomers,deals:renderDeals,
    activities:renderActivities,operations:renderOperations,team:renderTeam,other:renderModules}[state.page]||renderOverview)(root);
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

// M195: team management is strictly tenant-scoped by authenticated local API.
async function loadTeam(){
  if(!state.token||state.page!=='team')return;
  const mark=state.generation, token=state.token;
  try{
    const work=api('titan.work.list',{limit:200});
    const sla=api('titan.work.sla');
    const notices=api('titan.notifications.list',{limit:100,unread_only:false});
    const members=canEdit()?api('titan.team.members.list'):Promise.resolve({members:[]});
    const [a,b,c,d]=await Promise.all([work,sla,notices,members]);
    if(mark!==state.generation||token!==state.token||state.page!=='team')return;
    state.team={work:a.items,sla:b.counts,notices:c.items,unread:c.unread_count,members:d.members};
    render();
  }catch(e){notice(e.message||tr('refreshError'));}
}
function teamActionButton(label,click,style='secondary'){
  const b=make('button',style,label);b.type='button';b.onclick=click;return b;
}
function renderTeam(root){
  root.appendChild(pageHeading(tr('teamTitle'),tr('teamSubtitle')));
  const data=state.team;
  const tools=make('div','team-tools');
  tools.appendChild(teamActionButton(tr('refresh'),loadTeam));
  if(canEdit())tools.appendChild(teamActionButton(tr('scanDeadlines'),async()=>{
    try{await api('titan.notifications.refresh',{},true);await loadTeam();notice(tr('scanDone'));}
    catch(e){notice(e.message||tr('failed'));}
  }));
  if(canEdit())tools.appendChild(teamActionButton(tr('newWork'),()=>teamCreateForm(root),'primary'));
  root.appendChild(tools);
  if(!data){root.appendChild(make('p','spinner',tr('loading')));return;}
  const metrics=make('div','stats');
  add(metrics,summaryCard(tr('openWork'),data.sla.open+data.sla.in_progress),
    summaryCard(tr('overdue'),data.sla.overdue),
    summaryCard(tr('dueSoon'),data.sla.due_soon),
    summaryCard(tr('unreadNotices'),data.unread));
  root.appendChild(metrics);
  const tasks=panel(tr('teamTasks'),tr('teamTasksSubtitle'));
  const taskList=make('div','records');
  if(!data.work.length)empty(taskList,tr('noWork'));
  for(const item of data.work){
    const info=item.assignee+' · '+tr(item.priority)+' · '+(item.due_at?formatDate(item.due_at):tr('noDue'));
    const view=record(item.title,info);
    view.controls.appendChild(make('span','tag '+item.status,tr(item.status)));
    const detail=make('div','team-detail');
    view.controls.appendChild(teamActionButton(tr('history'),async()=>{
      if(detail.dataset.visible==='1'){detail.replaceChildren();detail.dataset.visible='0';return;}
      try{
        const h=await api('titan.work.history',{id:item.id});
        detail.replaceChildren(make('p','small-muted',tr('localHistory')));
        for(const ev of h.events){
          detail.appendChild(make('div','team-event',ev.actor+' · '+tr(ev.action)+' · '+formatDate(ev.created_at)));
          if(ev.action==='note')detail.appendChild(make('p','small-muted',ev.payload.message));
        }
        detail.dataset.visible='1';
      }catch(e){notice(e.message||tr('failed'));}
    }));
    if(canEdit()&&(state.identity.role==='owner'||item.assignee===state.identity.actor)&&item.status==='open'){
      view.controls.appendChild(teamActionButton(tr('takeWork'),async()=>{
        try{await api('titan.work.status',{id:item.id,expected_version:item.version,status:'in_progress'},true);
          notice(tr('saved'));await loadTeam();}
        catch(e){notice(e.message||tr('versionConflict'));await loadTeam();}
      }));
    }
    if(canEdit()&&(state.identity.role==='owner'||item.assignee===state.identity.actor)&&
      ['open','in_progress'].includes(item.status)){
      view.controls.appendChild(teamActionButton(tr('finishWork'),async()=>{
        try{await api('titan.work.status',{id:item.id,expected_version:item.version,status:'done'},true);
          notice(tr('completed'));await loadTeam();}
        catch(e){notice(e.message||tr('versionConflict'));await loadTeam();}
      }));
    }
    if(state.identity.role==='owner'&&!['done','cancelled'].includes(item.status)){
      const assign=make('select','team-assign');assign.setAttribute('aria-label',tr('assignee'));
      const opts=[...new Set(data.members.map(x=>x.actor))];
      for(const name of opts){const opt=make('option','',name);opt.value=name;assign.appendChild(opt);}
      assign.value=item.assignee;
      const move=teamActionButton(tr('reassign'),async()=>{
        try{await api('titan.work.assign',{id:item.id,expected_version:item.version,assignee:assign.value},true);
          notice(tr('saved'));await loadTeam();}
        catch(e){notice(e.message||tr('versionConflict'));await loadTeam();}
      });
      view.controls.append(assign,move);
    }
    const wrapper=make('div','team-item');wrapper.append(view.row,detail);taskList.appendChild(wrapper);
  }
  tasks.appendChild(taskList);root.appendChild(tasks);
  const inbox=panel(tr('inbox'),tr('inboxSubtitle'));
  const list=make('div','records');
  if(!data.notices.length)empty(list,tr('noNotices'));
  for(const msg of data.notices){
    const view=record(msg.body,formatDate(msg.created_at));
    if(!msg.read_at&&canEdit())view.controls.appendChild(teamActionButton(tr('ack'),async()=>{
      try{await api('titan.notifications.ack',{notification_id:msg.id},true);await loadTeam();}
      catch(e){notice(e.message||tr('failed'));}
    }));
    else if(msg.read_at)view.controls.appendChild(make('span','tag done',tr('done')));
    list.appendChild(view.row);
  }
  inbox.appendChild(list);root.appendChild(inbox);
}
function teamCreateForm(root){
  root.querySelector('#teamForm')?.remove();
  const panelEl=panel(tr('newWork'),tr('teamFormHelp'));
  const form=make('form','team-form');form.id='teamForm';
  const title=make('input');title.required=true;title.maxLength=160;title.placeholder=tr('workTitle');
  title.setAttribute('aria-label',tr('workTitle'));
  const description=make('textarea');description.rows=2;description.maxLength=1200;
  description.placeholder=tr('workDetails');description.setAttribute('aria-label',tr('workDetails'));
  const priority=make('select');priority.setAttribute('aria-label',tr('priority'));
  for(const key of ['low','normal','high','critical']){const option=make('option','',tr(key));option.value=key;priority.appendChild(option);}
  priority.value='normal';
  const due=make('input');due.type='datetime-local';due.setAttribute('aria-label',tr('due'));
  const assignee=make('select');assignee.setAttribute('aria-label',tr('assignee'));
  if(state.identity.role==='owner'){
    for(const name of [...new Set(state.team.members.map(x=>x.actor))]){
      const option=make('option','',name);option.value=name;assignee.appendChild(option);
    }
  }else {const option=make('option','',state.identity.actor);option.value=state.identity.actor;assignee.appendChild(option);}
  form.append(title,description,priority,due,assignee);
  const submit=make('button','primary',tr('create'));submit.type='submit';form.appendChild(submit);
  form.onsubmit=async e=>{
    e.preventDefault();submit.disabled=true;
    const payload={title:title.value,description:description.value,priority:priority.value,assignee:assignee.value};
    if(due.value){const seconds=Math.floor(new Date(due.value).getTime()/1000);
      if(!Number.isSafeInteger(seconds)){notice(tr('dueDateInvalid'));submit.disabled=false;return;}
      payload.due_at=seconds;
    }
    try{await api('titan.work.create',payload,true);notice(tr('created'));await loadTeam();}
    catch(err){notice(err.message||tr('failed'));}
    finally{submit.disabled=false;}
  };
  panelEl.appendChild(form);root.insertBefore(panelEl,root.children[2]||null);title.focus();
}
