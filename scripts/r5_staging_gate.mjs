/** Read-only HTTP gate for a dedicated HTTPS STAGING host. It will never issue form submissions or trigger email. */
import {pathToFileURL} from 'node:url';
const localOnly=new Set(['staging.osmanx.world']);
export async function runStagingGate(origin,{fetcher=fetch}={}){
 let base;try{base=new URL(origin);}catch{throw Error('Invalid staging origin');}
 if(base.protocol!=='https:'||!localOnly.has(base.hostname)||base.pathname!=='/'||base.search||base.hash)throw Error('Only https://staging.osmanx.world/ permitted');
 const results=[];
 async function probe(path,predicate,label){let response;try{response=await fetcher(new URL(path,base),{redirect:'manual',headers:{'Cache-Control':'no-cache'}});const ct=response.headers.get('content-type')||'';let data='';if(response.status===200&&ct.includes('text/html'))data=(await response.text()).slice(0,50000);else if(response.status===200&&ct.includes('application/json'))data=(await response.text()).slice(0,50000);const good=predicate(response,data);results.push({label,pass:good,status:response.status});}catch(e){results.push({label,pass:false,status:'network-error'});}}
 await probe('/moscow-1000/',(r,s)=>r.status===200&&s.includes('1000 ДВЕРЕЙ'),'site');
 await probe('/moscow-1000/episodes/01/',(r,s)=>r.status===200&&s.includes('OSMANX'),'episode');
 await probe('/moscow-1000/api/health',(r,s)=>r.status===200&&s.includes('leadsEnabled'),'health');
 await probe('/moscow-1000/api/public-release',(r,s)=>r.status===200&&s.includes('status')&&!/"email"\s*:|"phone"\s*:|"contactName"\s*:/.test(s),'public-data-privacy');
 await probe('/moscow-1000/api/admin/session',r=>[401,403].includes(r.status),'admin-denied');
 await probe('/moscow-1000/editor/',r=>[302,303,401,403].includes(r.status),'editor-access-protected');
 await probe('/moscow-1000/editor/editor.js',r=>[302,303,401,403].includes(r.status),'editor-script-access-protected');
 await probe('/services/moscow-1000-api/wrangler.toml',r=>r.status===404,'private-config-not-exposed');
 return {ok:results.every(r=>r.pass),origin:base.origin,results,requests:'GET-only',writesPerformed:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){runStagingGate(process.argv[2]||'').then(x=>{console.log(JSON.stringify(x,null,2));if(!x.ok)process.exitCode=1;}).catch(e=>{console.error('R5 staging BLOCKED:',e.message);process.exitCode=1;});}
