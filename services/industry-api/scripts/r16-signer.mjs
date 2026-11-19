/**
 * Two independent operator signing stations. A signer receives only their own
 * private Ed25519 key and the exact unsigned manifest; assembly uses PUBLIC keys.
 * Never combines private keys, overwrites files or deploys.
 */
import {createPrivateKey,generateKeyPairSync,sign} from 'node:crypto';
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readOutsideCheckout} from '../src/guest-tenant-authorization.mjs';
import {evaluateRegistry,registryMessage,R16_SCHEMA} from '../src/guest-r16-registry.mjs';

const UNBOUND=['schema','releaseCommit','revision','issuedAt','expiresAt','tenants','revoked'];
const PART=['role','actorId','signature'];
const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).sort().join('|')===[...keys].sort().join('|');
const HUMAN=/^[A-Za-z0-9._-]{3,80}$/;
const fake=Buffer.alloc(64).toString('base64');
export function validateUnsigned(record,now=new Date()){
  if(!exact(record,UNBOUND)||record.schema!==R16_SCHEMA)
    throw Error('Unsigned registry must contain exactly the expected fields');
  // Reuse the actual R16 schema and freshness engine while intentionally
  // excluding ONLY the two signatures that are not yet available.
  const owner=generateKeyPairSync('ed25519');
  const manager=generateKeyPairSync('ed25519');
  const check={...record,attestations:[
    {role:'owner',actorId:'unsigned-owner',signature:fake},
    {role:'manager',actorId:'unsigned-manager',signature:fake}
  ]};
  const res=evaluateRegistry(check,{
    owner:owner.publicKey.export({type:'spki',format:'pem'}),
    manager:manager.publicKey.export({type:'spki',format:'pem'})
  },record.releaseCommit,record.revision,now);
  if(res.blockers.some(x=>!['bad_owner_signature','bad_manager_signature'].includes(x)))
    throw Error('Unsigned registry violates R16 schema, lifetime or ordering');
  return true;
}
export function signPartial(unsigned,{role,actorId,privatePem},now=new Date()){
  validateUnsigned(unsigned,now);
  if(!['owner','manager'].includes(role)||!HUMAN.test(actorId||''))
    throw Error('Invalid signer identity');
  const key=createPrivateKey(privatePem);
  if(key.asymmetricKeyType!=='ed25519')throw Error('Ed25519 private key required');
  const part={role,actorId};
  return {...part,signature:sign(null,
    Buffer.from(registryMessage(unsigned,part),'utf8'),key).toString('base64')};
}
export function assembleRegistry(unsigned,parts,keys,now=new Date()){
  validateUnsigned(unsigned,now);
  if(!Array.isArray(parts)||parts.length!==2||
     !exact(parts[0],PART)||!exact(parts[1],PART))
    throw Error('Require two independent signature files');
  const record={...unsigned,attestations:parts};
  const status=evaluateRegistry(record,keys,unsigned.releaseCommit,unsigned.revision,now);
  if(!status.valid)throw Error('Signed registry assembly denied');
  return record;
}
async function createNew(path,content){
  if(typeof path!=='string'||!path.startsWith('/'))throw Error('Absolute output required');
  const h=await open(resolve(path),'wx',0o600);
  try{await h.writeFile(content);await h.sync();}
  finally{await h.close();}
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    const [command,...args]=process.argv.slice(2);
    if(command==='sign'&&args.length===5){
      const [role,actorId,unsignedFile,privateKeyFile,out]=args;
      const unsigned=JSON.parse(await readOutsideCheckout(unsignedFile,{privateFile:true}));
      const privatePem=await readOutsideCheckout(privateKeyFile,{privateFile:true});
      const part=signPartial(unsigned,{role,actorId,privatePem});
      await createNew(out,JSON.stringify(part)+'\n');
      process.stdout.write('R16 individual signature created; no registry published.\n');
    }else if(command==='assemble'&&args.length===6){
      const [unsignedFile,ownerFile,managerFile,ownerPublic,managerPublic,out]=args;
      const files=await Promise.all([unsignedFile,ownerFile,managerFile,ownerPublic,managerPublic]
        .map((path,i)=>readOutsideCheckout(path,{privateFile:i<3})));
      const unsigned=JSON.parse(files[0]);
      const record=assembleRegistry(unsigned,[JSON.parse(files[1]),JSON.parse(files[2])],
        {owner:files[3],manager:files[4]});
      await createNew(out,JSON.stringify(record)+'\n');
      process.stdout.write('R16 signed registry assembled, validated and ready for independent operator deployment.\n');
    }else{
      throw Error('Usage: sign role actorId /unsigned.json /own-private.pem /part.json OR assemble /unsigned.json /owner.part.json /manager.part.json /owner.pub.pem /manager.pub.pem /registry.json');
    }
  }catch{
    process.stderr.write('R16 signature operation refused. Check evidence, independent keys and private file permissions.\n');
    process.exitCode=2;
  }
}
