import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';

const root=resolve(import.meta.dirname,'..');
const context={URL,URLSearchParams};
runInNewContext(readFileSync(resolve(root,'moscow-1000/command-navigation.js'),'utf8'),context);
const nav=context.OSMANXNavigation;
const plain=value=>JSON.parse(JSON.stringify(value));
function disk(initial=null){let value=initial;return {getItem:()=>value,setItem:(_,v)=>{value=v;},get value(){return value;}};}

test('R8 navigation: all screens, days and subtabs round-trip in a shareable URL',()=>{
  for(let day=1;day<=10;day++)for(const view of ['hq','map','analytics','journal','quests']){
    const input={day,view,analysis:'budget',journal:'published',point:`area-${day}-0`};
    assert.deepEqual(plain(nav.parse(nav.shareURL(input,'https://example.test'))),plain(nav.normalize(input)));
  }
});
test('R8 navigation: links contain only public route parameters and keep the current site origin',()=>{
  const url=nav.shareURL({day:4,view:'map',point:'area-4-1',email:'private@example.test'},'https://site.test/admin/?token=secret&code=oauth#private');
  assert.equal(url,'https://site.test/moscow-1000/?day=4&point=area-4-1#map');
  assert.doesNotMatch(url,/secret|oauth|private|admin/);
  for(const value of ['javascript:alert(1)','file:///tmp/a','https://user:password@site.test'])assert.equal(nav.shareURL({},value),null);
});
test('R8 navigation: malformed days, unknown tabs and hostile point IDs are rejected',()=>{
  for(const input of ['?day=-1#map','?day=11#map','?day=1.5#map','?day=NaN#map'])assert.equal(nav.parse(input).day,1);
  assert.equal(nav.parse('?day=3&tab=published#analytics').analysis,'summary');
  for(const point of ['<script>','../../admin','area-2-0','x'.repeat(81)])assert.equal(nav.normalize({day:3,view:'map',point}).point,null);
  assert.equal(nav.normalize({day:3,view:'map',point:'public_approved-123'}).point,'public_approved-123');
  assert.equal(nav.normalize({day:3,view:'map',point:'area-community'}).point,'area-community');
  assert.equal(nav.parse('?day=3#unknown').view,'hq');
});
test('R8 navigation: irrelevant point and tab values do not create duplicate bookmarks',()=>{
  assert.equal(nav.equal({day:2,view:'hq',point:'area-2-0',analysis:'budget'},{day:2,view:'hq'}),true);
  assert.equal(nav.equal({day:2,view:'analytics',analysis:'budget'},{day:2,view:'analytics',analysis:'summary'}),false);
});
test('R8 bookmarks: explicit save persists only route identifiers, survives restart and deduplicates',()=>{
  const storage=disk(),store=nav.createStore(storage),route={day:4,view:'map',point:'area-4-0',name:'Private Name',contact:'private@example.test'};
  assert.equal(storage.value,null);
  assert.equal(store.add(route).status,'saved');assert.equal(store.add(route).status,'exists');
  assert.equal(nav.createStore(storage).read().length,1);
  assert.equal(store.read()[0].route.day,4);
  assert.doesNotMatch(storage.value,/Private|private|contact|name/);
});
test('R8 bookmarks: full storage does not silently evict the oldest saved place',()=>{
  const storage=disk(),store=nav.createStore(storage);
  for(let n=0;n<20;n++)assert.equal(store.add({day:n%10+1,view:n<10?'hq':'quests'},1700000000000+n).status,'saved');
  const before=storage.value;
  assert.equal(store.add({day:1,view:'map'}).status,'full');assert.equal(storage.value,before);
  const first=store.read()[19].id;assert.equal(store.remove(first),true);assert.equal(store.read().length,19);
  assert.equal(store.add({day:1,view:'map'}).status,'saved');
});
test('R8 bookmarks: malformed, oversized and unsupported persisted data is safe',()=>{
  for(const input of ['broken','x'.repeat(20001),'{"schema":2,"items":[]}','{"schema":1,"items":[null,{},42]}'])assert.equal(nav.createStore(disk(input)).read().length,0);
  const payload={schema:1,items:[{route:{day:2,view:'map',point:'<img>',title:'injected'},savedAt:'2026-11-20T00:00:00Z'},{route:{day:99,view:'map'},savedAt:'2026-11-20T00:00:00Z'}]};
  const value=nav.createStore(disk(JSON.stringify(payload))).read();assert.equal(value.length,1);assert.equal(value[0].route.point,null);assert.equal(value[0].title,undefined);
});
test('R8 bookmarks: denied or exhausted device storage reports failure without pretending to save',()=>{
  const blocked={getItem(){throw Error('denied');},setItem(){throw Error('quota');}};
  for(const storage of [null,blocked]){const store=nav.createStore(storage);assert.equal(store.add({day:1,view:'hq'}).status,'unavailable');assert.equal(store.read().length,0);}
});
test('R8 bookmarks: independent tabs re-read latest data before updating',()=>{
  const storage=disk(),one=nav.createStore(storage),two=nav.createStore(storage);
  one.add({day:1,view:'hq'});two.add({day:2,view:'hq'});assert.equal(one.read().length,2);
  one.remove(one.read()[1].id);assert.equal(two.read().length,1);assert.equal(two.read()[0].route.day,2);
});

const commandSource=readFileSync(resolve(root,'moscow-1000/command.js'),'utf8');
function actualFunction(name){
  const multiline=commandSource.match(new RegExp('^  function '+name+'\\([^\\n]*\\{\\n[\\s\\S]*?^  \\}','m'));
  const single=commandSource.match(new RegExp('^  function '+name+'\\([^\\n]+$','m'));
  assert.ok(multiline||single,'Actual command controller function '+name+' must exist.');
  return (multiline||single)[0];
}

// Execute the controller functions as shipped, against the real URL module.
// Only the map's documented selection API and browser history are boundaries;
// this host does not recreate rendering, authorization or publication logic.
function controller({route={day:1,view:'map',point:'wanted'},connection='current',selected='area-1-0',points=['area-1-0','area-1-1']}={}){
  let url=new URL(nav.shareURL(route,'https://example.test')),current=selected;
  const entries=[url.href],historyCalls=[],calls=[];let index=0;
  const known=new Set(points);
  const state={...nav.normalize(route),connection:{editorial:connection},map:{
    getSelectedPoint:()=>current?{id:current}:null,
    selectPoint(id,options){calls.push(['select',id,plain(options)]);if(!known.has(id))return false;current=id;return true;},
    clearSelection(options){calls.push(['clear',plain(options)]);current=null;},
    setDay(day){calls.push(['day',day]);current=null;}
  }};
  const location={get href(){return url.href;},get pathname(){return url.pathname;},get search(){return url.search;},get hash(){return url.hash;}};
  const history={
    replaceState(_a,_b,path){url=new URL(path,url);entries[index]=url.href;historyCalls.push(['replace',path]);},
    pushState(_a,_b,path){url=new URL(path,url);entries.splice(index+1);entries.push(url.href);index++;historyCalls.push(['push',path]);}
  };
  const host={state,navigation:nav,location,history,renderAll(){calls.push(['render']);},showView(view,options){calls.push(['view',view,plain(options)]);},renderNavigationTools(){calls.push(['tools']);}};
  runInNewContext('let appliedRouteURL="";\n'+['syncMapSelection','applyRoute','navigate','restoreRoute'].map(actualFunction).join('\n'),host);
  return {...host,calls,historyCalls,known,get current(){return current;},get url(){return url.href;},back(){if(index>0){url=new URL(entries[--index]);host.restoreRoute();}},forward(){if(index<entries.length-1){url=new URL(entries[++index]);host.restoreRoute();}}};
}

test('R8 navigation integration: missing published point clears the old map card and canonicalizes only confirmed absence',()=>{
  const host=controller();host.syncMapSelection();
  assert.equal(host.current,null);assert.equal(host.state.point,null);
  assert.equal(host.url,'https://example.test/moscow-1000/?day=1#map');
  assert.equal(host.historyCalls.length,1);assert.equal(host.historyCalls[0][0],'replace');
  assert.ok(host.calls.some(call=>call[0]==='tools'));
});

test('R8 navigation integration: cache/network uncertainty keeps intended point URL until fresh publication arrives',()=>{
  for(const connection of ['pending','cached','unavailable']){
    const host=controller({connection});host.syncMapSelection();
    assert.equal(host.current,null,connection+' must not display the previous point');
    assert.equal(host.state.point,'wanted');assert.equal(host.historyCalls.length,0);
    assert.equal(new URL(host.url).searchParams.get('point'),'wanted');
    host.known.add('wanted');host.state.connection.editorial='current';host.syncMapSelection();
    assert.equal(host.current,'wanted');assert.equal(host.state.point,'wanted');
    assert.equal(host.historyCalls.length,0);
  }
});

test('R8 navigation integration: nonexistent fixed plan anchors can be rejected offline without dropping valid author IDs',()=>{
  const host=controller({route:{day:1,view:'map',point:'area-1-99'},connection:'cached'});host.syncMapSelection();
  assert.equal(host.current,null);assert.equal(host.state.point,null);
  assert.equal(nav.normalize({day:1,view:'map',point:'area-community'}).point,'area-community');
  const author=controller({route:{day:1,view:'map',point:'area-community'},points:['area-community']});author.syncMapSelection();
  assert.equal(author.current,'area-community');assert.equal(author.state.point,'area-community');
  assert.equal(author.historyCalls.length,0);
});

test('R8 navigation integration: Back and Forward restore screen, day, subtab and selected map point without extra history entries',()=>{
  const host=controller({route:{day:1,view:'hq'},selected:null,points:['area-4-1']});
  host.navigate({day:4,view:'map',point:'area-4-1'});
  host.navigate({view:'analytics',analysis:'budget'});
  assert.equal(host.current,null);assert.equal(host.state.analysis,'budget');
  const writes=host.historyCalls.length;
  host.back();assert.equal(host.state.day,4);assert.equal(host.state.view,'map');assert.equal(host.current,'area-4-1');
  host.back();assert.equal(host.state.day,1);assert.equal(host.state.view,'hq');assert.equal(host.current,null);
  host.forward();assert.equal(host.state.day,4);assert.equal(host.current,'area-4-1');
  host.forward();assert.equal(host.state.view,'analytics');assert.equal(host.state.analysis,'budget');
  assert.equal(host.historyCalls.length,writes,'History traversal must not create a replacement navigation entry.');
  host.restoreRoute();assert.equal(host.historyCalls.length,writes,'The duplicate hashchange after popstate is harmless.');
});

test('R8 navigation integration: a withdrawn point is removed from historical URLs when revisited',()=>{
  const host=controller({route:{day:1,view:'hq'},selected:null,points:['published-one']});
  host.navigate({view:'map',point:'published-one'});host.navigate({view:'quests'});
  host.known.delete('published-one');host.back();
  assert.equal(host.state.view,'map');assert.equal(host.state.point,null);assert.equal(host.current,null);
  assert.equal(new URL(host.url).searchParams.has('point'),false);
  assert.equal(host.historyCalls.at(-1)[0],'replace');
});

test('R8 navigation integration: empty published journal opens the plan through history-aware navigation',()=>{
  const nodes=[],actions=[];
  const el=(tag,cls,text)=>{const node={tag,cls,text,children:[],append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},addEventListener(name,handler){this[name]=handler;}};nodes.push(node);return node;};
  const box=el('div');
  const host={state:{journal:'published',editorial:null},publicData:{episodes:[{day:1}]},$:()=>box,el,icon:()=>'',navigate:(...args)=>actions.push(plain(args))};
  runInNewContext(actualFunction('renderJournal'),host);host.renderJournal();
  const button=nodes.find(node=>node.tag==='button'&&node.text==='Посмотреть план');
  assert.ok(button);button.click();
  assert.deepEqual(actions,[[{view:'journal',journal:'all'},{focus:false}]]);
});
