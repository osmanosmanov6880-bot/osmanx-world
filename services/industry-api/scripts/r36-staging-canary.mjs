/**
 * Operator-only live semantic staging: 10 bounded, pinned TLS GET requests.
 * No network on import, no credentials and never production hostname.
 */
import {resolve4} from 'node:dns/promises';
import {connect,checkServerIdentity} from 'node:tls';
import {request} from 'node:https';
import {createHash,randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {R36_STAGE_SCHEMA,runR36SemanticStaging}
  from '../src/guest-r36-staging-content.mjs';
import {R35_PIN} from '../src/guest-r36-source.mjs';
const fp=buf=>createHash('sha256').update(buf).digest('hex');
export function tlsR36({host,ip}){
  return new Promise((resolve,reject)=>{
    const socket=connect({host:ip,port:443,servername:host,
      rejectUnauthorized:true,timeout:5000},()=>{
      try{
        const cert=socket.getPeerCertificate(true);
        if(!socket.authorized||!Buffer.isBuffer(cert?.raw))
          throw Error('Untrusted staging TLS chain');
        resolve({authorized:true,serverName:host,sha256:fp(cert.raw)});
      }catch(e){reject(e)}
      socket.end();
    });
    socket.once('error',reject);
    socket.once('timeout',()=>socket.destroy(Error('TLS timeout')));
  });
}
export function boundedR36Get({host,ip,method,path,certSha256,
  maxBodyBytes=4096}={}){
  return new Promise((resolve,reject)=>{
    if(host!=='staging.osmanx.world'||method!=='GET'||
      !/^\/api\/industry\/v1\/(?:health\/(?:live|ready)|guest\/pilots(?:\/00000000-0000-4000-8000-000000000000\/safety(?:\/export\.json)?)?)$/.test(path||'')||
      !/^[a-f0-9]{64}$/.test(certSha256||'')||
      maxBodyBytes!==4096)
      return reject(Error('Refusing unapproved staging GET'));
    const req=request('https://'+host+path,{
      method:'GET',agent:false,timeout:5000,
      rejectUnauthorized:true,
      lookup:(_hostname,_options,callback)=>callback(null,ip,4),
      checkServerIdentity:(hostname,cert)=>{
        const error=checkServerIdentity(hostname,cert);
        if(error)return error;
        if(!cert.raw||fp(cert.raw)!==certSha256)
          return Error('TLS certificate changed during the GET');
      },
      headers:{Accept:'application/json',
        'User-Agent':'osmanx-r36-semantic-staging','Cache-Control':'no-store'}
    },res=>{
      let bytes=0;const buffers=[];
      res.on('data',c=>{
        bytes+=c.length;
        if(bytes>maxBodyBytes){
          res.destroy(Error('Staging response body too large'));return;
        }
        buffers.push(c);
      });
      res.once('end',()=>resolve({
        status:res.statusCode,
        contentType:res.headers['content-type']||'',
        body:Buffer.concat(buffers).toString('utf8')
      }));
      res.once('error',reject);
    });
    req.once('timeout',()=>req.destroy(Error('Staging GET timeout')));
    req.once('error',reject);
    req.end();
  });
}
export async function runApprovedR36Canary({approval,approved=false,
  clock,delay,resolveIpv4=resolve4,inspectTls=tlsR36,
  fetchResponse=boundedR36Get}={}){
  return runR36SemanticStaging({approval,approved,resolveIpv4,
    inspectTls,fetchResponse,...(clock?{clock}:{}),
    delay:delay||((ms)=>new Promise(resolve=>setTimeout(resolve,ms)))});
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==7||
      process.argv[2]!=='--approved-staging'||
      process.env.GUEST_R36_OPERATOR_APPROVAL!=='APPROVED_SEMANTIC_STAGING')
      throw Error('R36 requires --approved-staging PILOT_UUID TREE_SHA IP CERT_SHA');
    const [pilotId,sourceTreeSha,approvedIpv4,approvedCertSha256]=
      process.argv.slice(3);
    const now=new Date();
    const approval={schema:R36_STAGE_SCHEMA,pilotId,
      sourceTreeSha,releaseSha:R35_PIN.sha,
      origin:'https://staging.osmanx.world',
      approvedIpv4,approvedCertSha256,
      issuedAt:now.toISOString(),
      expiresAt:new Date(now.getTime()+5*60000).toISOString(),
      nonce:randomBytes(16).toString('hex'),
      allowedMethods:['GET'],guestWritesExpected:false};
    const out=await runApprovedR36Canary({approval,approved:true});
    process.stdout.write(JSON.stringify(out)+'\n');
    if(out.productionAuthorized!==false)process.exitCode=2;
  }catch(error){
    process.stderr.write('R36 semantic staging NO-GO: '+error.message+'\n');
    process.exitCode=2;
  }
}
