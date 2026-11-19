import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {TICKET_SCHEMA,PLAN_FIELDS,validateTicketPlan,signTicketApproval,
  verifyChangeTicket,sha256} from '../scripts/r20-change-ticket.mjs';

function sample(){
  const now=new Date('2026-11-19T14:00:00.000Z');
  const keys={operator:generateKeyPairSync('ed25519'),
    reviewer:generateKeyPairSync('ed25519'),
    external:generateKeyPairSync('ed25519')};
  const plan={schema:TICKET_SCHEMA,ticketId:randomUUID(),
    tenantId:randomUUID(),pilotId:randomUUID(),
    releaseCommit:'a'.repeat(40),r19ScopeDigest:'b'.repeat(64),
    r18AnchorDigest:'c'.repeat(64),drProofDigest:'d'.repeat(64),
    offsiteReceiptDigest:'e'.repeat(64),rollbackSnapshotDigest:'f'.repeat(64),
    createdAt:'2026-11-19T13:30:00.000Z',
    windowStart:'2026-11-19T14:30:00.000Z',
    windowEnd:'2026-11-19T15:30:00.000Z',
    expiresAt:'2026-11-19T17:30:00.000Z'};
  const ctx={now,releaseCommit:plan.releaseCommit,
    tenantId:plan.tenantId,pilotId:plan.pilotId,
    scopeDigest:plan.r19ScopeDigest,anchorDigest:plan.r18AnchorDigest};
  const approve=(role,actorId,key)=>signTicketApproval(plan,{
    role,actorId,privatePem:key.privateKey.export({type:'pkcs8',format:'pem'}),
    now,context:ctx});
  const ticket={...plan,approvals:[
    approve('release_operator','osmanx-release',keys.operator),
    approve('independent_reviewer','separate-reviewer',keys.reviewer)]};
  const publicKeys={release_operator:keys.operator.publicKey.export({type:'spki',format:'pem'}),
    independent_reviewer:keys.reviewer.publicKey.export({type:'spki',format:'pem'})};
  return {now,plan,ticket,keys,publicKeys,ctx};
}
test('R20 two independent Ed25519 approvals verify the exact frozen release, one pilot and recovery receipts',()=>{
  const fx=sample();
  assert.deepEqual(validateTicketPlan(fx.plan,fx.ctx),[]);
  assert.deepEqual(Object.keys(fx.plan).sort(),[...PLAN_FIELDS].sort());
  const result=verifyChangeTicket(fx.ticket,fx.publicKeys,{
    ...fx.ctx,r18CustodianKey:fx.keys.external.publicKey.export({type:'spki',format:'pem'})
  });
  assert.equal(result.valid,true,JSON.stringify(result.blockers));
  assert.equal(result.independentSigners,true);
  assert.equal(result.productionAuthorized,false);
  assert.equal(result.customerGo,false);
  assert.equal(result.changedProduction,false);
  assert.match(result.ticketDigest,/^[a-f0-9]{64}$/);
});
test('R20 detects changed SHA, pilot, tenant, release, recovery proof and forged signature',()=>{
  const fx=sample(),verify=(ticket,ctx=fx.ctx)=>verifyChangeTicket(ticket,
    fx.publicKeys,ctx);
  assert.equal(verify({...fx.ticket,tenantId:randomUUID()}).valid,false);
  assert.equal(verify({...fx.ticket,r19ScopeDigest:'0'.repeat(64)}).valid,false);
  assert.equal(verify({...fx.ticket,drProofDigest:'0'.repeat(64)}).valid,false);
  assert.equal(verify(fx.ticket,{...fx.ctx,releaseCommit:'f'.repeat(40)}).valid,false);
  assert.equal(verify(fx.ticket,{...fx.ctx,pilotId:randomUUID()}).valid,false);
  assert.equal(verify({...fx.ticket,approvals:[
    {...fx.ticket.approvals[0],signature:'A'.repeat(86)+'=='},
    fx.ticket.approvals[1]]}).valid,false);
  assert.equal(verify({...fx.ticket,approvals:[
    fx.ticket.approvals[0],{...fx.ticket.approvals[1],actorId:'osmanx-release'}]}).valid,false);
});
test('R20 refuses recycled signing key and expired change window',()=>{
  const fx=sample();
  const replaced={...fx.publicKeys,
    independent_reviewer:fx.publicKeys.release_operator};
  assert.equal(verifyChangeTicket(fx.ticket,replaced,fx.ctx).valid,false);
  assert.equal(verifyChangeTicket(fx.ticket,fx.publicKeys,{...fx.ctx,
    now:new Date('2026-11-20T14:00:00.000Z')}).valid,false);
  const malformed={...fx.plan,expiresAt:'2026-11-20T18:00:00.000Z'};
  assert.ok(validateTicketPlan(malformed,fx.ctx).length>0);
  const unsupported={...fx.plan,extraField:'yes'};
  assert.ok(validateTicketPlan(unsupported,fx.ctx).length>0);
  const repeated={...fx.plan,offsiteReceiptDigest:fx.plan.drProofDigest};
  assert.ok(validateTicketPlan(repeated,fx.ctx).length>0);
  assert.throws(()=>signTicketApproval(malformed,{
    role:'release_operator',actorId:'operator',
    privatePem:fx.keys.operator.privateKey.export({type:'pkcs8',format:'pem'}),
    now:fx.now
  }));
});
