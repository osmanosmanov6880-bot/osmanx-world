/**
 * Independent two-human R20 deployment change ticket.
 * This is documentary evidence ONLY. It can NEVER approve live collection,
 * change a release gate, merge, deploy, sign on behalf of an operator, or
 * remove R13/R16/R19 STOP. Private keys stay OFF the server and out of CI.
 */
import {createHash,createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';
import {readFile,open,realpath} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const TICKET_SCHEMA='osmanx.guest.r20.two-person-change-ticket.v1';
export const TICKET_MESSAGE_SCHEMA='osmanx.guest.r20.ticket-message.v1';
export const PLAN_FIELDS=Object.freeze([
  'schema','ticketId','tenantId','pilotId','releaseCommit',
  'r19ScopeDigest','r18AnchorDigest','drProofDigest',
  'offsiteReceiptDigest','rollbackSnapshotDigest',
  'createdAt','windowStart','windowEnd','expiresAt'
]);
export const TICKET_FIELDS=[...PLAN_FIELDS,'approvals'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA=/^[0-9a-f]{64}$/;
const COMMIT=/^[0-9a-f]{40}$/;
const ID=/^[a-zA-Z0-9._-]{3,80}$/;
const SIG=/^[A-Za-z0-9+/]{86}==$/;
const roles=['release_operator','independent_reviewer'];
const exact=(x,fields)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===[...fields].sort().join('|');
const utc=v=>typeof v==='string'&&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&
  Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export const sha256=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function ticketPlanMessage(plan){
  return JSON.stringify({
    schema:TICKET_MESSAGE_SCHEMA,ticketId:plan.ticketId,
    tenantId:plan.tenantId,pilotId:plan.pilotId,
    releaseCommit:plan.releaseCommit,r19ScopeDigest:plan.r19ScopeDigest,
    r18AnchorDigest:plan.r18AnchorDigest,drProofDigest:plan.drProofDigest,
    offsiteReceiptDigest:plan.offsiteReceiptDigest,
    rollbackSnapshotDigest:plan.rollbackSnapshotDigest,
    createdAt:plan.createdAt,windowStart:plan.windowStart,
    windowEnd:plan.windowEnd,expiresAt:plan.expiresAt
  });
}
export function validateTicketPlan(plan,{now=new Date(),releaseCommit,
  tenantId,pilotId,scopeDigest,anchorDigest}={}){
  const blockers=[];
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw TypeError('Invalid clock');
  if(!exact(plan,PLAN_FIELDS)||plan.schema!==TICKET_SCHEMA||
    !UUID.test(plan.ticketId||'')||!UUID.test(plan.tenantId||'')||
    !UUID.test(plan.pilotId||'')||!COMMIT.test(plan.releaseCommit||'')||
    ['r19ScopeDigest','r18AnchorDigest','drProofDigest',
      'offsiteReceiptDigest','rollbackSnapshotDigest'].some(k=>!SHA.test(plan[k]||''))||
    new Set([plan.drProofDigest,plan.offsiteReceiptDigest,
      plan.rollbackSnapshotDigest]).size!==3)
    blockers.push('malformed_ticket_or_non_independent_evidence');
  const created=utc(plan?.createdAt)?Date.parse(plan.createdAt):NaN;
  const start=utc(plan?.windowStart)?Date.parse(plan.windowStart):NaN;
  const end=utc(plan?.windowEnd)?Date.parse(plan.windowEnd):NaN;
  const expiry=utc(plan?.expiresAt)?Date.parse(plan.expiresAt):NaN;
  if(!Number.isFinite(created)||!Number.isFinite(start)||!Number.isFinite(end)||
    !Number.isFinite(expiry)||created>now.getTime()||end<=start||
    start<created||end-start>2*3600000||end-start<60000||
    created+24*3600000<now.getTime()||expiry<end||
    expiry-created>24*3600000||expiry<=now.getTime())
    blockers.push('invalid_or_expired_change_window');
  if(releaseCommit!==undefined&&plan?.releaseCommit!==releaseCommit)
    blockers.push('wrong_release');
  if(tenantId!==undefined&&plan?.tenantId!==tenantId)blockers.push('wrong_tenant');
  if(pilotId!==undefined&&plan?.pilotId!==pilotId)blockers.push('wrong_pilot');
  if(scopeDigest!==undefined&&plan?.r19ScopeDigest!==scopeDigest)
    blockers.push('wrong_r19_scope');
  if(anchorDigest!==undefined&&plan?.r18AnchorDigest!==anchorDigest)
    blockers.push('wrong_r18_anchor');
  return blockers;
}
function ed25519(key){
  const pub=createPublicKey(key);
  if(pub.asymmetricKeyType!=='ed25519')throw Error('R20 requires Ed25519 public keys');
  return pub;
}
export function approvalMessage(plan,role,actorId){
  return JSON.stringify({schema:'osmanx.guest.r20.human-approval.v1',
    role,actorId,planMessage:ticketPlanMessage(plan)});
}
export function signTicketApproval(plan,{role,actorId,privatePem,
  now=new Date(),context={}}={}){
  if(!roles.includes(role)||!ID.test(actorId||'')||
    validateTicketPlan(plan,{now,...context}).length)
    throw Error('R20 invalid change approval plan');
  const key=createPrivateKey(privatePem);
  if(key.asymmetricKeyType!=='ed25519')throw Error('Ed25519 key required');
  return {role,actorId,signature:sign(null,
    Buffer.from(approvalMessage(plan,role,actorId),'utf8'),key).toString('base64')};
}
export function verifyChangeTicket(ticket,keys,{
  now=new Date(),releaseCommit,tenantId,pilotId,scopeDigest,anchorDigest,
  r19OperatorKey=null,r18CustodianKey=null
}={}){
  const blockers=[];
  if(!exact(ticket,TICKET_FIELDS)){
    blockers.push('invalid_ticket_shape');
  }
  const {approvals,...plan}=ticket&&typeof ticket==='object'?ticket:{};
  blockers.push(...validateTicketPlan(plan,{now,releaseCommit,tenantId,
    pilotId,scopeDigest,anchorDigest}));
  if(!Array.isArray(approvals)||approvals.length!==2||
    !roles.every((role,i)=>approvals[i]?.role===role)||
    approvals.some(x=>!exact(x,['role','actorId','signature'])||
      !ID.test(x.actorId||'')||!SIG.test(x.signature||'')||
      Buffer.from(x.signature||'','base64').toString('base64')!==x.signature))
    blockers.push('invalid_two_person_approvals');
  if(approvals?.[0]?.actorId===approvals?.[1]?.actorId)
    blockers.push('same_human_approved_both_roles');
  try{
    const pub=roles.map(role=>ed25519(keys?.[role]));
    if(pub[0].export({type:'spki',format:'der'}).equals(
      pub[1].export({type:'spki',format:'der'})))
      blockers.push('same_signing_key');
    for(const extra of [r19OperatorKey,r18CustodianKey].filter(Boolean)){
      const third=ed25519(extra).export({type:'spki',format:'der'});
      if(pub.some(k=>k.export({type:'spki',format:'der'}).equals(third)))
        blockers.push('change_approval_reuses_pilot_or_custodian_key');
    }
    for(let i=0;i<2;i++){
      const a=approvals[i];
      if(!verify(null,Buffer.from(approvalMessage(plan,a.role,a.actorId),'utf8'),
        pub[i],Buffer.from(a.signature,'base64')))
        blockers.push('invalid_signature_'+roles[i]);
    }
  }catch{blockers.push('untrusted_signatures');}
  return {schema:'osmanx.guest.r20.change-ticket-check.v1',
    valid:blockers.length===0,blockers:[...new Set(blockers)],
    ticketDigest:ticket&&typeof ticket==='object'?sha256(ticket):null,
    independentSigners:!!approvals?.length&&approvals[0]?.actorId!==approvals[1]?.actorId,
    documentaryReviewOnly:true,productionAuthorized:false,
    customerGo:false,changedProduction:false};
}
async function externalWrite(path,bytes){
  if(typeof path!=='string'||!path.startsWith('/')||resolve(path)!==path)
    throw Error('Absolute private output path required');
  const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
  if(path.startsWith(root+sep)||path===root)throw Error('Never write keys to source checkout');
  const parent=dirname(path);
  if(await realpath(parent)!==parent)throw Error('Symlinked directory rejected');
  const f=await open(path,'wx',0o600);
  try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    const [action,role,planPath,keyPath,output,...extra]=process.argv.slice(2);
    if(action!=='sign'||!roles.includes(role)||extra.length||
       !planPath||!keyPath||!output)
      throw Error('Usage: sign release_operator|independent_reviewer /private/plan.json /private/key.pem /private/approval.json');
    const [planText,pem]=await Promise.all([
      readFile(planPath,'utf8'),readFile(keyPath,'utf8')
    ]);
    const actorId=process.env.GUEST_R20_SIGNING_ACTOR_ID;
    const a=signTicketApproval(JSON.parse(planText),{
      role,actorId,privatePem:pem
    });
    await externalWrite(output,JSON.stringify(a)+'\n');
    process.stdout.write('Independent R20 approval created only; no customer or server activated.\n');
  }catch{
    process.stderr.write('R20 change ticket signing refused; no production change performed.\n');
    process.exitCode=2;
  }
}
