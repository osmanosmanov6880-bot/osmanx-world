/**
 * Human-approved network operation (never used in CI).
 * DNS and TLS are verified; GETs connect to a pinned public IPv4 to prevent
 * DNS rebinding, disallow redirects and discard response bodies.
 */
import {resolve4} from 'node:dns/promises';
import {connect} from 'node:tls';
import {request} from 'node:https';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {observeR34Staging} from '../src/guest-r34-host-evidence.mjs';
function verifyTls({host,ip}){
  return new Promise((done,reject)=>{
    const socket=connect({host:ip,port:443,servername:host,
      rejectUnauthorized:true,timeout:5000},()=>{
      try{
        const cert=socket.getPeerCertificate(true);
        if(!socket.authorized||!Buffer.isBuffer(cert?.raw))
          throw Error('TLS not authorized');
        done({authorized:true,serverName:host,
          sha256:createHash('sha256').update(cert.raw).digest('hex')});
      }catch(error){reject(error);}
      socket.end();
    });
    socket.once('error',reject);
    socket.once('timeout',()=>{socket.destroy(Error('TLS timeout'));});
  });
}
function statusOnly({host,ip,path,method}){
  return new Promise((done,reject)=>{
    if(method!=='GET'||!path.startsWith('/api/industry/v1/'))
      return reject(Error('Unapproved staging request'));
    const url='https://'+host+path;
    const req=request(url,{method:'GET',agent:false,timeout:5000,
      rejectUnauthorized:true,
      lookup:(_host,_opts,cb)=>cb(null,ip,4),
      headers:{Accept:'application/json','User-Agent':'osmanx-r34-staging-readonly'}},
    res=>{
      const status=res.statusCode;
      res.resume(); // discard bytes; never retain body
      res.once('end',()=>done(status));
      res.once('error',reject);
    });
    req.once('timeout',()=>req.destroy(Error('Staging GET timeout')));
    req.once('error',reject);
    req.end();
  });
}
export async function runApprovedR34Staging({approved=false,pilotId,
  sourceTreeSha,clock,delay}={}){
  return observeR34Staging({approved,pilotId,sourceTreeSha,
    resolveIpv4:resolve4,inspectTls:verifyTls,fetchStatus:statusOnly,
    ...(clock?{clock}:{}),
    delay:delay||((ms)=>new Promise(r=>setTimeout(r,ms)))});
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==5||process.argv[2]!=='--approved-staging'||
      process.env.GUEST_R34_OPERATOR_APPROVAL!=='APPROVED_READ_ONLY_STAGING')
      throw Error('Explicit approval and --approved-staging PILOT_UUID TREE_SHA required');
    const result=await runApprovedR34Staging({
      approved:true,pilotId:process.argv[3],sourceTreeSha:process.argv[4]
    });
    process.stdout.write(JSON.stringify(result)+'\n');
    if(!result.review.locallyObservedHealthy)process.exitCode=2;
  }catch(error){
    process.stderr.write('R34 staging NO-GO: '+error.message+'\n');
    process.exitCode=2;
  }
}
