/**
 * R6 deployment preflight. Never emits values, checks only names/shape/mode.
 * Does not execute .env or connect to a database or mutate infrastructure.
 */
import {readFile,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const SECRET_NAMES=Object.freeze([
  'POSTGRES_ADMIN_PASSWORD','INDUSTRY_APP_PASSWORD','INDUSTRY_WORKER_PASSWORD','WEBHOOK_HMAC_KEY'
]);
const HEX=/^[a-f0-9]{64}$/i;
const RECIPIENT=/^age1[a-z0-9]{50,80}$/;
export function parseEnv(input){
  if(typeof input!=='string'||input.length>65536)throw Error('Environment file is too large');
  const values=Object.create(null);
  for(const [i,line] of input.replaceAll('\r\n','\n').split('\n').entries()){
    if(!line.trim()||/^\s*#/.test(line))continue;
    const pair=line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if(!pair)throw Error('Malformed environment file at line '+(i+1));
    const [,name,raw]=pair;
    if(Object.hasOwn(values,name))throw Error('Duplicate environment field '+name);
    if(/[\r\n\0]/.test(raw)||raw.includes(String.fromCharCode(36,123))||
       raw.includes(String.fromCharCode(96)))throw Error('Unsafe environment value syntax at line '+(i+1));
    // No shell evaluation. Real values must be unquoted as required by the operator runbook.
    values[name]=raw;
  }
  return values;
}
export function validateEnvironment(env,{allowWrites=false}={}){
  const errors=[];
  const has=key=>typeof env[key]==='string'&&env[key].length>0;
  for(const name of SECRET_NAMES){
    const value=env[name];
    if(!HEX.test(String(value??''))||new Set(String(value??'').toLowerCase()).size<8)
      errors.push(name+': expected 64 high-entropy hex characters');
  }
  const all=SECRET_NAMES.map(k=>String(env[k]??'').toLowerCase());
  if(new Set(all).size!==all.length)errors.push('Database and webhook secrets must be independent');
  const bootstrap=String(env.BOOTSTRAP_PASSWORD??'');
  if(bootstrap.length<16||bootstrap.length>200||/REPLACE|PLACEHOLDER|EXAMPLE|123456/i.test(bootstrap)||
     new Set(bootstrap).size<10)errors.push('BOOTSTRAP_PASSWORD: use a unique strong password of 16-200 characters');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(env.BOOTSTRAP_EMAIL??''))||
     /@example\.(com|test|org|net)$/i.test(String(env.BOOTSTRAP_EMAIL??'')))
    errors.push('BOOTSTRAP_EMAIL: provide a real owner-controlled address');
  if(!/^[a-z0-9][a-z0-9-]{1,63}$/.test(String(env.BOOTSTRAP_TENANT_SLUG??'')))
    errors.push('BOOTSTRAP_TENANT_SLUG: invalid company slug');
  if(!['lab','dental','auto','beauty','fitness','cafe','cleaning'].includes(env.BOOTSTRAP_VERTICAL))
    errors.push('BOOTSTRAP_VERTICAL: not in the allowed list');
  if(!has('BOOTSTRAP_TENANT_NAME')||env.BOOTSTRAP_TENANT_NAME.length>120)
    errors.push('BOOTSTRAP_TENANT_NAME: required, max 120 characters');
  for(const name of ['AGE_RECIPIENT_1','AGE_RECIPIENT_2'])
    if(!RECIPIENT.test(String(env[name]??'')))errors.push(name+': invalid age recipient');
  if(env.AGE_RECIPIENT_1===env.AGE_RECIPIENT_2)
    errors.push('AGE recipients must belong to independent keys');
  if(env.GUEST_WRITES_ENABLED===undefined)errors.push('GUEST_WRITES_ENABLED must be explicitly false before staging');
  else if(env.GUEST_WRITES_ENABLED!=='false' && env.GUEST_WRITES_ENABLED!=='true')
    errors.push('GUEST_WRITES_ENABLED must be true or false');
  else if(env.GUEST_WRITES_ENABLED==='true'&&!allowWrites)
    errors.push('Guest writes may only be enabled with explicit operator --allow-writes after acceptance');
  const url=String(env.WEBHOOK_URL??'');
  if(url){
    let safe=false;
    try{
      const value=new URL(url);
      safe=value.protocol==='https:'&&!value.username&&!value.password&&!value.hash &&
        !/\bexample\./.test(value.hostname);
    }catch{}
    if(!safe)errors.push('WEBHOOK_URL: HTTPS receiver required, without credentials or placeholders');
  }
  const forbidden=Object.keys(env).filter(key=>/TOKEN|PRIVATE_KEY|AWS_|STRIPE_|DATABASE_URL/.test(key));
  if(forbidden.length)errors.push('Unexpected secret key names in environment: '+forbidden.join(', '));
  return {schema:'osmanx.guest.r6.preflight.v1',ok:errors.length===0,checks:{
    independentDbSecrets:!errors.some(x=>x.includes('secrets')||x.includes('64 high-entropy')),
    independentBackupRecipients:!errors.some(x=>x.includes('recipient')||x.includes('AGE')),
    operatorExplicitlyEnabled:env.GUEST_WRITES_ENABLED==='true'&&allowWrites
  },errors};
}
export async function inspectFile(path,{allowWrites=false}={}){
  const target=resolve(path),st=await lstat(target);
  if(!st.isFile()||st.isSymbolicLink())throw Error('Environment file must be a regular non-symlink file');
  if((st.mode&0o077)!==0)throw Error('Environment file must not be readable by group or other (chmod 600)');
  const parsed=parseEnv(await readFile(target,'utf8'));
  const result=validateEnvironment(parsed,{allowWrites});
  return {...result,envFileMode:'private'};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  const args=process.argv.slice(2);
  if(args.length>2||args.some(x=>x.startsWith('-')&&x!=='--allow-writes'))
    throw Error('Usage: node scripts/preflight.mjs [path/to/.env] [--allow-writes]');
  const file=args.find(x=>x!=='--allow-writes')||'.env';
  let report;
  try{report=await inspectFile(file,{allowWrites:args.includes('--allow-writes')});}
  catch(error){report={schema:'osmanx.guest.r6.preflight.v1',ok:false,errors:[error.message]};}
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
  if(!report.ok)process.exitCode=2;
}
