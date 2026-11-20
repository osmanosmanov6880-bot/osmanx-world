/* Small zero-dependency interactive OSM tile viewer. Only tiles in viewport; no bulk download/prefetch. */
(function () {
  'use strict';
  const d=window.OSMANX_GEO;
  const map=document.getElementById('public-map');
  if(!map || !d || !Array.isArray(d.days))return;
  const layer=document.getElementById('map-tiles');
  const markers=document.getElementById('map-markers');
  const daysEl=document.getElementById('map-day-list');
  const anchorsEl=document.getElementById('map-anchor-list');
  const title=document.getElementById('map-day-title');
  const subtitle=document.getElementById('map-day-focus');
  const state={day:1,zoom:13,lat:55.751,lon:37.618,drag:null,alive:true};
  let approvedMarkers=[];
  const T=256;
  const clamp=(n,a,b)=>Math.min(b,Math.max(a,n));
  const rad=x=>x*Math.PI/180;
  function project(lat,lon,z){const size=T*2**z;const sin=clamp(Math.sin(rad(clamp(lat,-85.0511,85.0511))),-.9999,.9999);return {x:(lon+180)/360*size,y:(.5-Math.log((1+sin)/(1-sin))/(4*Math.PI))*size};}
  function unproject(x,y,z){const size=T*2**z;const lon=x/size*360-180;const n=Math.PI*(1-2*y/size);const lat=Math.atan(Math.sinh(n))*180/Math.PI;return {lat:clamp(lat,-85,85),lon:((lon+540)%360)-180};}
  function centerDay(n){const route=d.days.find(x=>x.number===n);if(!route)return;state.day=n;state.zoom=n===9?13:14;state.lat=route.anchors.reduce((s,x)=>s+x.lat,0)/route.anchors.length;state.lon=route.anchors.reduce((s,x)=>s+x.lng,0)/route.anchors.length;render();}
  let scheduled=false;
  function requestRender(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;renderMap();});}
  function renderMap(){if(!state.alive)return;const w=map.clientWidth,h=map.clientHeight;if(!w||!h)return;const c=project(state.lat,state.lon,state.zoom);const minX=c.x-w/2,minY=c.y-h/2,maxX=minX+w,maxY=minY+h;
    layer.replaceChildren();markers.replaceChildren();const extent=2**state.zoom;
    const ax=clamp(Math.floor(minX/T),0,extent-1),bx=clamp(Math.floor(maxX/T),0,extent-1);const ay=clamp(Math.floor(minY/T),0,extent-1),by=clamp(Math.floor(maxY/T),0,extent-1);
    // Hard stop avoids excessive tile requests on unusual viewport sizes.
    let budget=0;for(let tx=ax;tx<=bx;tx++)for(let ty=ay;ty<=by;ty++){if(++budget>64)break;const tile=document.createElement('img');tile.className='osm-tile';tile.alt='';tile.draggable=false;tile.loading='lazy';tile.decoding='async';tile.referrerPolicy='strict-origin-when-cross-origin';tile.style.left=(tx*T-minX)+'px';tile.style.top=(ty*T-minY)+'px';tile.width=T;tile.height=T;tile.src=`https://tile.openstreetmap.org/${state.zoom}/${tx}/${ty}.png`;layer.append(tile);}
    const route=d.days.find(r=>r.number===state.day);for(const a of route.anchors){const p=project(a.lat,a.lng,state.zoom);const b=document.createElement('button');b.className='map-pin';b.type='button';b.style.left=(p.x-minX)+'px';b.style.top=(p.y-minY)+'px';b.title=a.label+' — ориентир';b.setAttribute('aria-label','Ориентир: '+a.label);b.textContent='●';b.addEventListener('click',()=>{const items=[...anchorsEl.querySelectorAll('a')];const idx=route.anchors.indexOf(a);if(items[idx])items[idx].focus();});markers.append(b);}
    for(const m of approvedMarkers.filter(x=>x.day===state.day)){const p=project(m.lat,m.lng,state.zoom);const pin=document.createElement('button');pin.type='button';pin.className='map-pin map-approved-pin';pin.style.left=(p.x-minX)+'px';pin.style.top=(p.y-minY)+'px';pin.textContent='◆';pin.title=m.title+' · проверено редакцией';pin.setAttribute('aria-label','Проверенная публичная точка: '+m.title);pin.addEventListener('click',()=>{const row=anchorsEl.querySelector('[data-public-id="'+m.id+'"]');row?.scrollIntoView?.({block:'nearest'});row?.querySelector('a')?.focus();});markers.append(pin);}
  }
  function render(){for(const button of daysEl.querySelectorAll('button')){const selected=Number(button.dataset.day)===state.day;button.setAttribute('aria-pressed',String(selected));button.classList.toggle('active',selected);}const item=d.days[state.day-1];title.textContent='День '+item.number+' · '+item.title;subtitle.textContent=item.focus;anchorsEl.replaceChildren();for(const a of item.anchors){const li=document.createElement('li');const label=document.createElement('span');label.textContent=a.label+' · ориентир';const link=document.createElement('a');link.target='_blank';link.rel='noopener noreferrer';link.href='https://www.openstreetmap.org/?mlat='+encodeURIComponent(a.lat)+'&mlon='+encodeURIComponent(a.lng)+'#map=16/'+a.lat+'/'+a.lng;link.textContent='Посмотреть на карте ↗';li.append(label,link);anchorsEl.append(li);}
    for(const m of approvedMarkers.filter(x=>x.day===state.day)){const li=document.createElement('li');li.dataset.publicId=m.id;const label=document.createElement('span');label.textContent='Проверено · '+m.title+' — '+m.summary;const a=document.createElement('a');a.href='/moscow-1000/episodes/'+String(m.episode).padStart(2,'0')+'/';a.textContent='Связанный выпуск ↗';li.append(label,a);anchorsEl.append(li);}const dayLink=document.getElementById('map-episode-link');if(dayLink)dayLink.href='/moscow-1000/episodes/'+String(state.day).padStart(2,'0')+'/';requestRender();}
  for(const r of d.days){const b=document.createElement('button');b.type='button';b.className='day-chip';b.dataset.day=String(r.number);b.textContent='День '+r.number;b.addEventListener('click',()=>{centerDay(r.number);history.replaceState(null,'','?day='+r.number+'#map');});daysEl.append(b);}
  const requestedDay=Number(new URLSearchParams(location.search).get('day'));centerDay(Number.isInteger(requestedDay)&&requestedDay>=1&&requestedDay<=10?requestedDay:1);
  for(const [id,dir] of [['map-zoom-in',1],['map-zoom-out',-1]])document.getElementById(id)?.addEventListener('click',()=>{state.zoom=clamp(state.zoom+dir,10,18);requestRender();});
  document.getElementById('map-reset')?.addEventListener('click',()=>centerDay(state.day));
  map.addEventListener('pointerdown',ev=>{if(ev.target.closest('button'))return;map.setPointerCapture?.(ev.pointerId);state.drag={x:ev.clientX,y:ev.clientY,lat:state.lat,lon:state.lon};map.classList.add('dragging');});
  map.addEventListener('pointermove',ev=>{if(!state.drag)return;const p=project(state.drag.lat,state.drag.lon,state.zoom);const q=unproject(p.x-(ev.clientX-state.drag.x),p.y-(ev.clientY-state.drag.y),state.zoom);state.lat=q.lat;state.lon=q.lon;requestRender();});
  function finish(){state.drag=null;map.classList.remove('dragging');}
  map.addEventListener('pointerup',finish);map.addEventListener('pointercancel',finish);map.addEventListener('lostpointercapture',finish);
  map.addEventListener('wheel',ev=>{ev.preventDefault();state.zoom=clamp(state.zoom+(ev.deltaY<0?1:-1),10,18);requestRender();},{passive:false});
  map.addEventListener('keydown',ev=>{const step=80;const p=project(state.lat,state.lon,state.zoom);const arrow={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]}[ev.key];if(arrow){ev.preventDefault();const v=unproject(p.x+arrow[0],p.y+arrow[1],state.zoom);state.lat=v.lat;state.lon=v.lon;requestRender();}else if(ev.key==='+'||ev.key==='-'){ev.preventDefault();state.zoom=clamp(state.zoom+(ev.key==='+'?1:-1),10,18);requestRender();}});
  const resize=new ResizeObserver(requestRender);resize.observe(map);
  window.addEventListener('osmanx-reviewed-release',event=>{const list=event.detail?.markers;approvedMarkers=Array.isArray(list)?list.filter(m=>m&&Number.isInteger(m.day)&&m.day>=1&&m.day<=10&&Number.isFinite(m.lat)&&Number.isFinite(m.lng)&&typeof m.id==='string'&&/^[A-Za-z0-9_-]{6,80}$/.test(m.id)):[];render();});
  window.OSMANX_MAP_TEST_HOOKS={project,unproject,get state(){return {...state}},get approvedCount(){return approvedMarkers.length}};
})();
