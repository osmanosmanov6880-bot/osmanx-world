/** Read-only staging smoke. Never modifies production, databases, sends email or bypasses Access. */
export async function runStagingGate(origin,fetcher=fetch){
 const url=new URL(origin);if(url.protocol!=='https:'||url.hostname!=='staging.osmanx.world'||url.pathname!=='/'||url.search)throw Error('Only https://staging.osmanx.world/ may be tested');
 const checks=[];async function check(path,allowed,matcher){const r=await fetcher(url.origin+path,{redirect:'manual',headers:{'Cache-Control':'no-cache'}});const text=await r.text();const pass=allowed.includes(r.status)&&(!matcher||matcher(text,r));checks.push({path,status:r.status,pass});if(!pass)throw Error('Staging check failed: '+path+' HTTP '+r.status);return r;}
 await check('/moscow-1000/',[200],txt=>txt.includes('1000 ДВЕРЕЙ'));
 await check('/moscow-1000/editor/',[302,401,403]);
 await check('/moscow-1000/editor/media-studio.js',[302,401,403]);
 await check('/moscow-1000/api/health',[200],txt=>{const json=JSON.parse(txt);return typeof json.ok==='boolean';});
 await check('/moscow-1000/api/public-release',[200],txt=>{const x=JSON.parse(txt);return x.schemaVersion===3&&['published','unpublished'].includes(x.status)&&!txt.includes('email_hash');});
 await check('/moscow-1000/api/admin/session',[302,401,403]);
 await check('/moscow-1000/api/admin/leads',[302,401,403]);
 return {ok:true,origin:url.origin,checks};
}
if(process.argv[1]?.endsWith('check_r4_staging.mjs')){
 const host=process.argv[2];if(!host){console.error('Usage: node scripts/check_r4_staging.mjs https://staging.osmanx.world/');process.exit(2);}
 runStagingGate(host).then(x=>console.log(JSON.stringify(x,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
