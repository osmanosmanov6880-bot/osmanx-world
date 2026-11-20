import {copy,films,getFilm,filterFilms,pageUrl,sectorIds} from './content.js';
import {mountPlanner} from './planner-ui.js';
import {openFilmRoute,closeFilmRoute} from './film-route.js';
const locale=document.body.dataset.locale==='en'?'en':'ru',t=copy[locale];
const sector=sectorIds.includes(document.body.dataset.sector)?document.body.dataset.sector:'other';
mountPlanner({calculatorEl:document.getElementById('pilot-calculator'),briefEl:document.getElementById('project-brief'),locale,sector});
const menu=document.getElementById('mobile-menu');
document.getElementById('menu-toggle').addEventListener('click',()=>menu.showModal());
menu.querySelector('[data-close-menu]').addEventListener('click',()=>menu.close());
menu.addEventListener('click',e=>{if(e.target.closest('a'))menu.close();});
const privacy=document.getElementById('privacy-dialog');
document.getElementById('privacy-open').addEventListener('click',()=>privacy.showModal());
document.getElementById('privacy-close').addEventListener('click',()=>privacy.close());
let activeFilter='all';
const search=document.getElementById('film-search');
function refreshFilms(){const found=filterFilms(search.value,activeFilter),ids=new Set(found.map(x=>x.id));document.querySelectorAll('[data-film-card]').forEach(el=>el.hidden=!ids.has(el.dataset.filmCard));document.getElementById('film-results').textContent=t.results+': '+found.length;document.getElementById('film-empty').hidden=!!found.length;}
document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{activeFilter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));refreshFilms();}));
search.addEventListener('input',refreshFilms);
document.getElementById('film-reset').addEventListener('click',()=>{search.value='';activeFilter='all';document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.filter==='all')));refreshFilms();search.focus();});
const dialog=document.getElementById('video-dialog'),player=document.getElementById('film-player');
const errorEl=document.getElementById('video-error');
const routeOwner=globalThis.crypto?.randomUUID?.()||`${Date.now()}:${Math.random()}`;
let activeFilm=null,opener=null,closePending=false,pendingDestination=null;
function cleanPlayer(){player.pause();player.removeAttribute('src');player.replaceChildren();player.load();errorEl.hidden=true;}
function hideFilm({restoreFocus=true}={}){
 const target=opener;cleanPlayer();activeFilm=null;opener=null;
 if(dialog.open)dialog.close();
 if(restoreFocus&&target?.isConnected)target.focus({preventScroll:true});
}
function dismissFilm({destination=null}={}){
 if(closePending||!dialog.open)return;
 const route=closeFilmRoute(location.href,history.state,{owner:routeOwner});
 if(route.method==='back'){
  closePending=true;pendingDestination=destination;player.pause();history.back();
 }else{
  if(route.method)history[route.method](route.state,'',route.url);
  hideFilm({restoreFocus:!destination});
  if(destination)location.assign(destination);
 }
}
function showFilm(id,{source='route',button=null}={}){
 const film=getFilm(id);if(!film)return false;
 const route=openFilmRoute(location.href,history.state,id,{source,owner:routeOwner});
 if(!dialog.open)opener=button||document.activeElement;
 cleanPlayer();activeFilm=film;
 document.getElementById('video-title').textContent=film[locale];
 document.getElementById('video-description').textContent=film[locale==='en'?'descriptionEn':'descriptionRu'];
 document.getElementById('video-audio').textContent=id==='feature'?t.withAudio:t.noAudio;
 document.getElementById('share-status').textContent='';document.getElementById('share-fallback').hidden=true;
 player.poster=film.poster;player.setAttribute('aria-label',film[locale]);player.src=film.video;
 if(film.captions&&locale==='ru'){const track=document.createElement('track');track.kind='captions';track.label='Смысловые главы и музыка';track.srclang='ru';track.src=film.captions;player.append(track);}
 const target=sectorIds.includes(film.sector)?film.sector:'';
 document.getElementById('video-cta').href=pageUrl(locale,target)+'#brief';
 document.getElementById('video-download').href=film.video;
 if(!dialog.open)dialog.showModal();
 if(route.method)history[route.method](route.state,'',route.url);
 if(route.autoplay)player.play().catch(()=>{/* Native controls remain available when autoplay policy declines playback. */});
 return true;
}
document.querySelectorAll('[data-open-film]').forEach(button=>button.addEventListener('click',()=>showFilm(button.dataset.openFilm,{source:'user',button})));
player.addEventListener('error',()=>{if(activeFilm&&player.getAttribute('src'))errorEl.hidden=false;});
player.addEventListener('loadeddata',()=>{errorEl.hidden=true;});
document.getElementById('video-retry').addEventListener('click',()=>{if(!activeFilm)return;errorEl.hidden=true;player.load();player.play().catch(()=>{});});
document.getElementById('video-close').addEventListener('click',()=>dismissFilm());
dialog.addEventListener('cancel',event=>{event.preventDefault();dismissFilm();});
document.getElementById('video-cta').addEventListener('click',event=>{
 if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
 event.preventDefault();dismissFilm({destination:event.currentTarget.href});
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)player.pause();});
document.getElementById('video-share').addEventListener('click',async()=>{if(!activeFilm)return;const url=new URL(pageUrl(locale,sector),location.origin);url.searchParams.set('film',activeFilm.id);try{await navigator.clipboard.writeText(url.href);document.getElementById('share-status').textContent=t.copied;}catch{const field=document.querySelector('#share-fallback input');field.value=url.href;document.getElementById('share-fallback').hidden=false;document.getElementById('share-status').textContent=t.copyFallback;field.focus();field.select();}});
function fromURL(){
 const destination=pendingDestination;pendingDestination=null;closePending=false;
 if(destination){hideFilm({restoreFocus:false});location.assign(destination);return;}
 const id=new URL(location.href).searchParams.get('film');
 if(id&&getFilm(id)){if(activeFilm?.id!==id||!dialog.open)showFilm(id,{source:'route'});else player.pause();}
 else if(dialog.open||activeFilm)hideFilm();
}
window.addEventListener('popstate',fromURL);fromURL();
