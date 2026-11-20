/* Fail-safe scan of a proposed Wrangler staging TOML. Deliberately DOES NOT inspect or output secrets. */
import fs from 'node:fs';
export function inspectStagingConfig(s){const failures=[];
 if(!/name\s*=\s*"osmanx-moscow-1000-api-staging"/.test(s))failures.push('Wrong staging Worker name');
 if(!/staging\.osmanx\.world\/moscow-1000\/api\/\*/.test(s))failures.push('Missing staging-only API route');
 if(/pattern\s*=\s*"osmanx\.world\//.test(s))failures.push('Production route forbidden');
 if(!/database_name\s*=\s*"osmanx-moscow-1000-staging"/.test(s))failures.push('Need dedicated staging D1');
 if(!/SITE_ORIGIN\s*=\s*"https:\/\/staging\.osmanx\.world"/.test(s))failures.push('Incorrect staging site origin');
 if(!/DIGEST_DELIVERY_ENABLED\s*=\s*"false"/.test(s))failures.push('Staging mail must be disabled initially');
 if(!/STREAM_UPLOAD_ENABLED\s*=\s*"false"/.test(s))failures.push('Staging uploads must be disabled initially');
 if(/(?:STREAM_API_TOKEN|EDITORIAL_BACKUP_KEY|RESEND_API_KEY|TURNSTILE_SECRET)\s*=/.test(s))failures.push('A secret appears in the tracked TOML');
 if(/REPLACE_WITH/.test(s))failures.push('Unconfigured required identifiers');
 return failures;
}
if(process.argv[1]?.endsWith('inspect_r4_config.mjs')){const p=process.argv[2];if(!p){console.error('Provide path to a locally completed private staging TOML');process.exit(2);}const fail=inspectStagingConfig(fs.readFileSync(p,'utf8'));if(fail.length){console.error('BLOCKED: '+fail.join('; '));process.exit(1);}console.log('R4 staging configuration preflight passed (not a deployment)');}
