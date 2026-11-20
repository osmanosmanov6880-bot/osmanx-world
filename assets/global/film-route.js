// A per-document owner marks entries created by this dialog, not authentication.
const ENTRY='osmanxGlobalFilm';
const relative=url=>url.pathname+url.search+url.hash;
function cleanState(state){const next=state&&typeof state==='object'&&!Array.isArray(state)?{...state}:{};delete next[ENTRY];return next;}
function baseURL(url){const base=new URL(url.href);base.searchParams.delete('film');return relative(base);}
function ownsEntry(url,state,owner){const mark=state?.[ENTRY];return !!owner&&mark?.owner===owner&&mark.film===url.searchParams.get('film')&&mark.returnTo===baseURL(url);}

export function openFilmRoute(href,state,id,{source='route',owner=''}={}){
  const url=new URL(href);
  if(source!=='user')return {method:null,url:relative(url),state,autoplay:false};
  const next=new URL(url.href);next.searchParams.set('film',id);
  if(next.href===url.href)return {method:null,url:relative(next),state,autoplay:true};
  const nextState=cleanState(state);
  if(ownsEntry(url,state,owner))nextState[ENTRY]={...state[ENTRY],film:id};
  else if(!url.searchParams.has('film'))nextState[ENTRY]={owner,film:id,returnTo:relative(url)};
  // Changing an already open/direct-linked film does not grow a modal stack.
  return {method:url.searchParams.has('film')?'replaceState':'pushState',url:relative(next),state:nextState,autoplay:true};
}

export function closeFilmRoute(href,state,{owner=''}={}){
  const url=new URL(href),nextState=cleanState(state);
  if(!url.searchParams.has('film'))return {method:null,url:relative(url),state:nextState};
  return {method:ownsEntry(url,state,owner)?'back':'replaceState',url:baseURL(url),state:nextState};
}
