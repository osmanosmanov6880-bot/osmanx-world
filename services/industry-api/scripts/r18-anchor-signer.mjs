/**
 * R18 detached auditor signing station. No private key is needed on API host.
 * The signer independently checks the same R16/R17 public evidence before
 * creating a single R18 receipt; it never deploys or enables writes.
 */
import {createPrivateKey,sign} from 'node:crypto';
import {open,realpath} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readOutsideCheckout} from '../src/guest-tenant-authorization.mjs';
import {loadR17Witness} from '../src/guest-r17-witness.mjs';
import {anchorPlan,anchorMessage,ANCHOR_SCHEMA,PLAN_FIELDS}
  from '../src/guest-r18-anchor.mjs';
const exact=(a,keys)=>a&&typeof a==='object'&&!Array.isArray(a)&&
  Object.keys(a).sort().join('|')===[...keys].sort().join('|');
async function externalNew(path,text){
  if(typeof path!=='string'||!path.startsWith('/'))
    throw Error('Absolute path required');
  const target=resolve(path),parent=dirname(target);
  const real=await realpath(parent);
  const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
  if(real!==parent||target===root||target.startsWith(root+sep))
    throw Error('Refusing signer file inside checkout or symbolic directory');
  const handle=await open(target,'wx',0o600);
  try{await handle.writeFile(text);await handle.sync();}
  finally{await handle.close();}
}
export function validateAnchorPlan(plan,witness,{now=new Date(),releaseCommit}={}){
  if(!exact(plan,PLAN_FIELDS)||plan.schema!==ANCHOR_SCHEMA||
     plan.role!=='custodian')throw Error('Unexpected custodian plan schema');
  const begin=Date.parse(plan.issuedAt),end=Date.parse(plan.expiresAt);
  if(!Number.isFinite(begin)||!Number.isFinite(end)||begin>now.getTime()||
     end<=now.getTime()||end<=begin||(end-begin)>4*3600000||
     (end-begin)%60000!==0)
    throw Error('Expired, forged or imprecise anchor plan dates');
  const expected=anchorPlan({...witness,releaseCommit},{
    now:new Date(begin),minutes:(end-begin)/60000,actorId:plan.actorId
  });
  if(JSON.stringify(expected)!==JSON.stringify(plan))
    throw Error('Custodian plan does not match signed R17 evidence');
  return true;
}
export function signExternalAnchor(plan,privatePem){
  if(!exact(plan,PLAN_FIELDS)||plan.schema!==ANCHOR_SCHEMA||
     plan.role!=='custodian')throw Error('Invalid anchor plan');
  const key=createPrivateKey(privatePem);
  if(key.asymmetricKeyType!=='ed25519')
    throw Error('Ed25519 external custodian private key required');
  return {...plan,signature:sign(null,Buffer.from(anchorMessage(plan),'utf8'),
    key).toString('base64')};
}
export async function commandR18Signer(args,env=process.env,now=new Date()){
  const [action,...values]=args;
  const witness=await loadR17Witness(env,now);
  if(action==='plan'&&values.length===1){
    const plan=anchorPlan({...witness,releaseCommit:env.GUEST_RELEASE_COMMIT},{
      now,minutes:90,actorId:env.GUEST_R18_CUSTODIAN_ID||'external-custodian'
    });
    await externalNew(values[0],JSON.stringify(plan)+'\n');
    return {planCreated:true,sequence:plan.journalSequence,productionChanged:false};
  }
  if(action==='sign'&&values.length===3){
    const [planPath,keyPath,receiptPath]=values;
    const [planText,pem]=await Promise.all([
      readOutsideCheckout(planPath,{privateFile:true}),
      readOutsideCheckout(keyPath,{privateFile:true})
    ]);
    const plan=JSON.parse(planText);
    validateAnchorPlan(plan,witness,{now,releaseCommit:env.GUEST_RELEASE_COMMIT});
    const signed=signExternalAnchor(plan,pem);
    await externalNew(receiptPath,JSON.stringify(signed)+'\n');
    return {signed:true,sequence:plan.journalSequence,productionChanged:false};
  }
  throw Error('Usage: plan /private/plan.json OR sign /private/plan.json /private/custodian-private.pem /private/anchor.json');
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{process.stdout.write(JSON.stringify(await commandR18Signer(process.argv.slice(2)))+'\n');}
  catch{
    process.stderr.write('R18 custodian signing refused; verify independent R17 evidence and private key storage.\n');
    process.exitCode=2;
  }
}
