import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {makeHostAttestation,verifyHostAttestation,sanitizedHostFacts,
  hostFactsSha,ATTEST_SCHEMA} from '../scripts/r22-host-witness.mjs';

function fixture(){
  const now=new Date('2026-11-19T16:30:00.000Z');
  const tenantId=randomUUID(),pilotId=randomUUID();
  const releaseCommit='f'.repeat(40);
  const snapshot={os:'linux',nodeMajor:22,
    environmentMode:'production',allowedOriginIsExact:true,
    writesEnabled:false,custodyConfigured:true,
    pathsOutsideCheckout:true,privateFilesSafe:true,publicKeysSafe:true,
    canaryListener:'loopback',postgresExposed:false,gatheredOnHost:true,
    fabricatedSecret:'PRIVATE_SIGNING_KEY_MUST_NEVER_EXPORT'};
  const pairs=Array.from({length:4},()=>generateKeyPairSync('ed25519'));
  const pub=k=>pairs[k].publicKey.export({format:'pem',type:'spki'});
  const hostTrust={operator:pub(0),r18:pub(1),r19:pub(2),r20:pub(3)};
  const attestation=makeHostAttestation(snapshot,{
    privatePem:pairs[0].privateKey.export({format:'pem',type:'pkcs8'}),
    operatorId:'independent-host-auditor',tenantId,pilotId,
    releaseCommit,now
  });
  const context={
    operatorPublicKey:hostTrust.operator,
    r18CustodianPublicKey:hostTrust.r18,
    r19SignerPublicKey:hostTrust.r19,
    r20ReleasePublicKey:hostTrust.r20,
    releaseCommit,tenantId,pilotId,now
  };
  return {snapshot,attestation,pairs,hostTrust,context,now,
    tenantId,pilotId,releaseCommit};
}
test('R22 independent Ed25519 witness covers only redacted local host facts and a single pilot',()=>{
  const f=fixture(),a=f.attestation;
  assert.equal(a.schema,ATTEST_SCHEMA);
  assert.equal(a.hostFactsSha,hostFactsSha(f.snapshot));
  assert.equal(JSON.stringify(sanitizedHostFacts(f.snapshot)).includes('PRIVATE_SIGNING_KEY'),false);
  assert.equal(JSON.stringify(a).includes('PRIVATE_SIGNING_KEY'),false);
  const report=verifyHostAttestation(f.snapshot,a,f.context);
  assert.equal(report.valid,true,JSON.stringify(report.blockers));
  assert.equal(report.independentSignatureValid,true);
  assert.equal(report.hostTechnicalChecksPassed,true);
  assert.equal(report.actualHostVerifiedByThisSoftware,false);
  assert.equal(report.productionAuthorized,false);
});
test('R22 refuses signature forgery, key reuse, changed host listeners and wrong release',()=>{
  const f=fixture();
  assert.equal(verifyHostAttestation({...f.snapshot,
    canaryListener:'public'},f.attestation,f.context).valid,false);
  assert.equal(verifyHostAttestation({...f.snapshot,
    postgresExposed:true},f.attestation,f.context).valid,false);
  assert.equal(verifyHostAttestation(f.snapshot,{
    ...f.attestation,tenantId:randomUUID()
  },f.context).valid,false);
  assert.equal(verifyHostAttestation(f.snapshot,f.attestation,{
    ...f.context,releaseCommit:'a'.repeat(40)
  }).valid,false);
  assert.equal(verifyHostAttestation(f.snapshot,f.attestation,{
    ...f.context,r19SignerPublicKey:f.context.operatorPublicKey
  }).valid,false);
  assert.equal(verifyHostAttestation(f.snapshot,{
    ...f.attestation,signature:'A'.repeat(86)+'=='
  },f.context).valid,false);
});
test('R22 host attestation expires after 30 min and never accepts a synthetic write-active host',()=>{
  const f=fixture();
  const expired=verifyHostAttestation(f.snapshot,f.attestation,{
    ...f.context,now:new Date(f.now.getTime()+31*60000)
  });
  assert.equal(expired.valid,false);
  assert.ok(expired.blockers.includes('expired_or_future_witness'));
  assert.throws(()=>makeHostAttestation({...f.snapshot,
    writesEnabled:true},{
    privatePem:f.pairs[0].privateKey.export({format:'pem',type:'pkcs8'}),
    operatorId:'tester',tenantId:f.tenantId,pilotId:f.pilotId,
    releaseCommit:f.releaseCommit,now:f.now
  }));
});
