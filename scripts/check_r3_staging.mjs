/** Check R3 staging safely without sending mail, changing settings or creating user data. */
const target=process.argv[2];
if(!target){console.error('Usage: node scripts/check_r3_staging.mjs https://STAGING_HOST');process.exit(2);}
let origin;try{const u=new URL(target);if(u.protocol!=='https:')throw Error('HTTPS required');if(u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Origin only');origin=u.origin;}catch(e){console.error('Invalid origin:',e.message);process.exit(2);}
const tests=[['Homepage','/'],['Public series','/moscow-1000/'],['Episode 01','/moscow-1000/episodes/01/'],['Editorial shell','/moscow-1000/editor/'],['Public API release','/moscow-1000/api/public-release'],['Protected admin','/moscow-1000/api/admin/session']];
let fails=0;
for(const [name,path] of tests){try{const response=await fetch(origin+path,{redirect:'manual',headers:{Accept:path.includes('/api/')?'application/json':'text/html'}});
 let ok=response.status<400;if(name==='Protected admin')ok=[301,302,303,307,308,401,403].includes(response.status);if(name==='Public API release'&&ok){const j=await response.json();ok=[2,3].includes(j.schemaVersion)&&['unpublished','published'].includes(j.status);}
 if(!ok)fails++;console.log(`${ok?'PASS':'FAIL'} ${name}: HTTP ${response.status}`);
}catch(e){fails++;console.error('FAIL',name,e.message);}}
console.log(fails?'Staging checks failed. Do not deploy.':'Staging read-only route checks passed. Manual Access, video, tile and email acceptance still required.');process.exitCode=fails?1:0;
