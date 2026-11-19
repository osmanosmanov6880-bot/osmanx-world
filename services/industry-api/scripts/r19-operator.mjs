/**
 * R19 independent operator scope signing and one-way emergency stop.
 * NO deploy, legal approval, production write enabling, file overwrite or
 * automatic resume. The private signing key is never sent to the API.
 */
import {createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {open,realpath} from 'node:fs/promises';
import {resolve,dirname,sep,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readOutsideCheckout} from '../src/guest-tenant-authorization.mjs';
import {loadR18Anchor} from '../src/guest-r18-anchor.mjs';
import {
  scopeMessage,verifyR19Scope,UNSIGNED_FIELDS,SCOPE_SCHEMA
} from '../src/guest-r19-scope.mjs';
const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).sort().join('|')===[...keys].sort().join('|');
async function exclusiveExternal(file,body){
  if(typeof file!=='string'||!file.startsWith('/')||resolve(file)!==file)
    throw Error('R19 requires an absolute external output path');
  const checkout=resolve(fileURLToPath(new URL('..',import.meta.url)));
  if(file===checkout||file.startsWith(checkout+sep))
    throw Error('R19 private signature files must be outside checkout');
  const dir=dirname(file);
  if(await realpath(dir)!==dir)throw Error('R19 symbolic output parent refused');
  const h=await open(file,'wx',0o600);
  try{await h.writeFile(body);await h.sync();}
  finally{await h.close();}
}
export function signR19Scope(unsigned,privatePem,{anchor,env,externalPublicPem,
  externalActor,now=new Date()}={}){
  if(!exact(unsigned,UNSIGNED_FIELDS)||unsigned.schema!==SCOPE_SCHEMA)
    throw Error('Unsigned R19 scope must contain precisely all required fields');
  const privateKey=createPrivateKey(privatePem);
  if(privateKey.asymmetricKeyType!=='ed25519')
    throw Error('Ed25519 operator signing key required');
  const signed={...unsigned,signature:sign(null,
    Buffer.from(scopeMessage(unsigned),'utf8'),privateKey).toString('base64')};
  const result=verifyR19Scope(signed,{
    operator:createPublicKey(privateKey).export({type:'spki',format:'pem'}),
    externalCustodian:externalPublicPem
  },anchor,{
    releaseCommit:env?.GUEST_RELEASE_COMMIT,now,
    minSequence:Number(env?.GUEST_R19_MIN_SEQUENCE),
    externalActor
  });
  if(!result.valid)throw Error('R19 scope signature/purpose/evidence/TTL or separation invalid');
  return signed;
}
export async function stopR19(env=process.env,{ack,reasonCode}={}){
  if(ack!=='CONFIRM_R19_PERMANENT_STOP'||![
    'client_request','consent_withdrawn','security_incident','lawful_basis_expired'
  ].includes(reasonCode))throw Error('Explicit independent STOP acknowledgement required');
  const path=env.GUEST_R19_STOP_FILE;
  if(typeof path!=='string'||basename(path)!=='STOP')
    throw Error('R19 STOP location missing');
  const report={schema:'osmanx.guest.r19.stop.v1',reasonCode,
    stoppedAt:new Date().toISOString(),resumableByApi:false};
  try{
    await exclusiveExternal(path,JSON.stringify(report)+'\n');
  }catch(e){
    if(e?.code==='EEXIST')
      return {stopped:true,alreadyStopped:true,productionWritesEnabled:false};
    throw Error('R19 STOP creation refused; contact independent operator');
  }
  return {stopped:true,alreadyStopped:false,productionWritesEnabled:false};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    const [action,...args]=process.argv.slice(2);
    if(action==='sign'&&args.length===3){
      const [unsignedFile,privateFile,output]=args;
      const [unsignedText,pem,externalPublicPem,externalText]=await Promise.all([
        readOutsideCheckout(unsignedFile,{privateFile:true}),
        readOutsideCheckout(privateFile,{privateFile:true}),
        readOutsideCheckout(process.env.GUEST_R18_CUSTODIAN_PUBLIC_KEY),
        readOutsideCheckout(process.env.GUEST_R18_ANCHOR_FILE,{privateFile:true})
      ]);
      const anchor=await loadR18Anchor(process.env);
      const signed=signR19Scope(JSON.parse(unsignedText),pem,{
        env:process.env,anchor,externalPublicPem,
        externalActor:JSON.parse(externalText).actorId
      });
      await exclusiveExternal(output,JSON.stringify(signed)+'\n');
      process.stdout.write('R19 independent signature created. No pilot has been activated.\n');
    }else if(action==='stop'&&args.length===2){
      const [reasonCode,ack]=args;
      const result=await stopR19(process.env,{reasonCode,ack});
      process.stdout.write(JSON.stringify(result)+'\n');
    }else throw Error('Usage: sign /unsigned-scope.json /private-operator-key.pem /scope.json OR stop client_request|consent_withdrawn|security_incident|lawful_basis_expired CONFIRM_R19_PERMANENT_STOP');
  }catch{
    process.stderr.write('R19 signing or STOP rejected. Check independent evidence and permissions; collection has not been enabled.\n');
    process.exitCode=2;
  }
}
