/** Operator-only live staging GET canary with pinned IP and cert. */
import {resolve4} from 'node:dns/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {verifyTls,statusOnly}
  from './r34-operator-staging.mjs';
import {R35_STAGING_SCHEMA,runR35PinnedStaging}
  from '../src/guest-r35-staging.mjs';
import {R34_PIN} from '../src/guest-r35-source.mjs';
export async function runR35ApprovedCanary({profile,approved=false,
  clock,delay,resolveIpv4=resolve4,inspectTls=verifyTls,
  fetchStatus=statusOnly}={}){
  return runR35PinnedStaging({profile,approved,
    resolveIpv4,inspectTls,fetchStatus,
    ...(clock?{clock}:{}),
    delay:delay||((ms)=>new Promise(r=>setTimeout(r,ms)))});
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==7||
      process.argv[2]!=='--approved-staging'||
      process.env.GUEST_R35_OPERATOR_APPROVAL!=='APPROVED_STAGING_GET_ONLY')
      throw Error('R35 requires explicit operator approval and four pinned arguments');
    const [pilotId,sourceTreeSha,approvedIpv4,approvedCertSha256]=
      process.argv.slice(3);
    const now=new Date();
    const profile={schema:R35_STAGING_SCHEMA,
      environment:'staging',origin:'https://staging.osmanx.world',
      releaseSha:R34_PIN.sha,sourceTreeSha,pilotId,approvedIpv4,
      approvedCertSha256,operatorNonce:randomBytes(16).toString('hex'),
      issuedAt:now.toISOString(),
      expiresAt:new Date(now.getTime()+5*60000).toISOString(),
      allowWrites:false};
    const result=await runR35ApprovedCanary({profile,approved:true});
    process.stdout.write(JSON.stringify(result)+'\n');
    if(!result.dnsAndTlsPinned)process.exitCode=2;
  }catch(error){
    process.stderr.write('R35 staging NO-GO: '+error.message+'\n');
    process.exitCode=2;
  }
}
