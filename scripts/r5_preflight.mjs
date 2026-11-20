/** CI preflight: only source/config shape; never claims staging exists. */
import {readFileSync,existsSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const required=['services/moscow-1000-api/migrations/0004_r5_visibility.sql','services/moscow-1000-api/tus.mjs','services/moscow-1000-api/visibility.mjs','moscow-1000/editor/tus-client.js'];
export function preflight(root){const reasons=[];for(const f of required)if(!existsSync(root+'/'+f))reasons.push('Missing '+f);
 const template=readFileSync(root+'/services/moscow-1000-api/wrangler.staging.toml.example','utf8');
 if(!template.includes('staging.osmanx.world/moscow-1000/api/*'))reasons.push('Staging route missing');
 if(!template.includes('REQUIRE_TWO_PERSON_REVIEW = "true"'))reasons.push('Independent review not enforced');
 if(!template.includes('DIGEST_DELIVERY_ENABLED = "false"'))reasons.push('Staging email must default disabled');
 if(!template.includes('STREAM_UPLOAD_ENABLED = "false"'))reasons.push('Staging upload must default disabled');
 if(existsSync(root+'/services/moscow-1000-api/.dev.vars')||existsSync(root+'/services/moscow-1000-api/wrangler.toml'))reasons.push('Potential local secret tracked');
 const worker=readFileSync(root+'/services/moscow-1000-api/index.mjs','utf8');if(!worker.includes('verifiedActor'))reasons.push('Access gate missing');
 const status={ok:!reasons.length,reasons,stagingDeployed:false,productionChanged:false};return status;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const result=preflight(new URL('..',import.meta.url).pathname.replace(/\/$/,''));console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}
