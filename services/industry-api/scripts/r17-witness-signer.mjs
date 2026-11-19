/**
 * R17 independent witness signing stations. Owner and manager never place
 * their private keys on the same machine or in the Git repository.
 * All outputs are exclusive private files outside the source checkout.
 */
import {createPrivateKey,sign} from 'node:crypto';
import {open,realpath} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readOutsideCheckout} from '../src/guest-tenant-authorization.mjs';
import {loadR16Registry} from '../src/guest-r16-registry.mjs';
import {digest,verifyJournal,witnessMessage,WITNESS_SCHEMA,
  JOURNAL_SCHEMA} from '../src/guest-r17-witness.mjs';
const PLAN_SCHEMA='osmanx.guest.r17.witness-plan.v1';
const PLAN_FIELDS=['schema','releaseCommit','registryRevision','registryDigest',
  'journalSequence','journalHead','issuedAt','expiresAt'];
const ID=/^[A-Za-z0-9._-]{3,80}$/;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&
  Object.keys(v).sort().join('|')===[...keys].sort().join('|');
export function buildWitnessPlan(registry,journal,{now=new Date(),expiresInMinutes=60}={}){
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
     !Number.isSafeInteger(expiresInMinutes)||expiresInMinutes<1||expiresInMinutes>360)
    throw Error('Invalid witness clock or duration');
  const proof=verifyJournal(journal,registry,now);
  if(!proof.valid)throw Error('Journal does not match signed registry');
  return {schema:PLAN_SCHEMA,releaseCommit:registry.releaseCommit,
    registryRevision:registry.revision,registryDigest:digest(registry),
    journalSequence:proof.sequence,journalHead:proof.head,
    issuedAt:now.toISOString(),
    expiresAt:new Date(now.getTime()+expiresInMinutes*60000).toISOString()};
}
export function verifyPlan(plan,registry,journal,now=new Date()){
  if(!exact(plan,PLAN_FIELDS)||plan.schema!==PLAN_SCHEMA)
    throw Error('Invalid witness plan');
  const issued=new Date(plan.issuedAt),expires=new Date(plan.expiresAt);
  if(!Number.isFinite(issued.getTime())||!Number.isFinite(expires.getTime())||
     issued.toISOString()!==plan.issuedAt||expires.toISOString()!==plan.expiresAt||
     issued.getTime()>now.getTime()+5000||expires.getTime()<=now.getTime()||
     expires.getTime()-issued.getTime()>6*3600000)
    throw Error('Witness plan expired or from the future');
  const computed=buildWitnessPlan(registry,journal,{now:issued,
    expiresInMinutes:(expires.getTime()-issued.getTime())/60000});
  if(JSON.stringify(plan)!==JSON.stringify(computed))
    throw Error('Witness plan disagrees with journal or registry');
  return true;
}
export function signWitnessPlan(plan,{role,actorId,privatePem},now=new Date()){
  if(!['owner','manager'].includes(role)||!ID.test(actorId||'')||
     !exact(plan,PLAN_FIELDS)||plan.schema!==PLAN_SCHEMA)
    throw Error('Invalid role or plan');
  const start=Date.parse(plan.issuedAt),end=Date.parse(plan.expiresAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||
     start>now.getTime()+5000||end<=now.getTime()||end-start>6*3600000)
    throw Error('Expired witness plan');
  const key=createPrivateKey(privatePem);
  if(key.asymmetricKeyType!=='ed25519')
    throw Error('Ed25519 private key required');
  const {schema,...rest}=plan;
  const unsigned={schema:WITNESS_SCHEMA,role,actorId,...rest};
  return {...unsigned,signature:sign(null,
    Buffer.from(witnessMessage(unsigned),'utf8'),key).toString('base64')};
}
async function writeExclusive(target,content){
  if(typeof target!=='string'||!target.startsWith('/'))
    throw Error('Absolute output path required');
  const filename=resolve(target),parent=dirname(filename);
  const actual=await realpath(parent);
  const checkout=resolve(fileURLToPath(new URL('..',import.meta.url)));
  if(actual!==parent||filename===checkout||filename.startsWith(checkout+sep))
    throw Error('Refusing source and symlinked output directories');
  const h=await open(filename,'wx',0o600);
  try{await h.writeFile(content);await h.sync();}
  finally{await h.close();}
}
export async function runSigner(args,env=process.env,now=new Date()){
  const [command,...p]=args;
  if(command==='plan'&&p.length===1){
    const r16=await loadR16Registry(env,now);
    const journal=JSON.parse(await readOutsideCheckout(env.GUEST_R17_JOURNAL_FILE,{privateFile:true}));
    const plan=buildWitnessPlan(r16.registry,journal,{now});
    await writeExclusive(p[0],JSON.stringify(plan)+'\n');
    return {planPrepared:true,registryRevision:plan.registryRevision,
      journalSequence:plan.journalSequence};
  }
  if(command==='sign'&&p.length===5){
    const [role,actorId,planFile,keyFile,outFile]=p;
    const [planText,pem]=await Promise.all([
      readOutsideCheckout(planFile,{privateFile:true}),
      readOutsideCheckout(keyFile,{privateFile:true})
    ]);
    const plan=JSON.parse(planText);
    const r16=await loadR16Registry(env,now);
    const journal=JSON.parse(await readOutsideCheckout(env.GUEST_R17_JOURNAL_FILE,{privateFile:true}));
    verifyPlan(plan,r16.registry,journal,now);
    const signed=signWitnessPlan(plan,{role,actorId,privatePem:pem},now);
    await writeExclusive(outFile,JSON.stringify(signed)+'\n');
    return {signed:true,role,registryRevision:plan.registryRevision};
  }
  throw Error('Usage: plan /private/plan.json OR sign owner|manager actorId /private/plan.json /own-private.pem /private/witness.json');
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{process.stdout.write(JSON.stringify(await runSigner(process.argv.slice(2)))+'\n');}
  catch{
    process.stderr.write('R17 independent signing refused: check private sources, version, expiry and permissions.\n');
    process.exitCode=2;
  }
}
