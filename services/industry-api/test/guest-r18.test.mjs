import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {syntheticR18} from './r18-synthetic-fixture.mjs';
import {loadR17Witness} from '../src/guest-r17-witness.mjs';
import {loadR18Anchor,verifyAnchor,r18Configured} from '../src/guest-r18-anchor.mjs';
import {exportProof,verifyProofFile} from '../scripts/r18-proof.mjs';
import {verifyPortableProof} from '../src/guest-r18-proof.mjs';
import {signExternalAnchor,validateAnchorPlan} from '../scripts/r18-anchor-signer.mjs';
import {rehearseRecovery} from '../scripts/r18-dr-rehearsal.mjs';
import {CHAIN,evaluateReleaseChain} from '../scripts/r18-release-gate.mjs';

async function setup(t){
  const ids=[randomUUID(),randomUUID()];
  const fx=await syntheticR18(ids);
  t.after(async()=>fx.cleanup());
  const keys={
    platformOwner:fx.r17.fx.operators.owner.publicKey.export({type:'spki',format:'pem'}),
    platformManager:fx.r17.fx.operators.manager.publicKey.export({type:'spki',format:'pem'}),
    witnessOwner:fx.r17.keys.owner.publicKey.export({type:'spki',format:'pem'}),
    witnessManager:fx.r17.keys.manager.publicKey.export({type:'spki',format:'pem'}),
    custodian:fx.custodian.publicKey.export({type:'spki',format:'pem'})
  };
  return {ids,fx,keys};
}
test('R18 independent third custodian signs the exact R17 head, sequence, release and TTL',async t=>{
  const {fx,keys}=await setup(t);
  const w=await loadR17Witness(fx.env,fx.now);
  const loaded=await loadR18Anchor(fx.env,w,fx.now);
  assert.equal(loaded.receiptVerified,true);
  assert.equal(loaded.offsiteStorageVerified,false);
  assert.equal(loaded.sequence,3);
  assert.equal(r18Configured(fx.env),true);
  assert.equal(r18Configured({GUEST_R17_JOURNAL_FILE:'/x'}),false);
  const witness={...w,releaseCommit:fx.env.GUEST_RELEASE_COMMIT};
  const options={now:fx.now,releaseCommit:fx.env.GUEST_RELEASE_COMMIT,
    minRevision:1,minSequence:1,
    witnessActors:['r17-independent-owner','r17-independent-manager']};
  const verify=(a=fx.anchor,k=keys,opts=options)=>verifyAnchor(a,witness,{
    owner:k.witnessOwner,manager:k.witnessManager,custodian:k.custodian
  },opts);
  assert.equal(verify().valid,true);
  assert.equal(verify({...fx.anchor,journalSequence:4}).valid,false);
  assert.equal(verify({...fx.anchor,signature:fx.anchor.signature.slice(0,-4)+'AAAA'}).valid,false);
  assert.equal(verify(fx.anchor,keys,{...options,minSequence:4}).valid,false);
  assert.equal(verify(fx.anchor,keys,{...options,
    now:new Date(fx.now.getTime()+3*3600000)}).valid,false);
  assert.equal(verify(fx.anchor,{...keys,custodian:keys.witnessOwner}).valid,false);
  assert.equal(verify(fx.anchor,keys,{...options,
    witnessActors:['external-auditor']}).valid,false);
  const plan={...fx.anchor};delete plan.signature;
  assert.equal(validateAnchorPlan(plan,w,{now:fx.now,
    releaseCommit:fx.env.GUEST_RELEASE_COMMIT}),true);
  const bad=signExternalAnchor({...plan,registryDigest:'c'.repeat(64)},
    fx.custodian.privateKey.export({type:'pkcs8',format:'pem'}));
  assert.equal(verify(bad).valid,false);
});
test('R18 missing receipt or broken offline evidence NEVER falls back to R17',async t=>{
  const {fx}=await setup(t);
  assert.equal((await loadR18Anchor(fx.env,null,fx.now)).receiptVerified,true);
  const partial={...fx.env};
  delete partial.GUEST_R18_CUSTODIAN_PUBLIC_KEY;
  await assert.rejects(loadR18Anchor(partial,null,fx.now));
  const wrong={...fx.env,GUEST_R18_ANCHOR_FILE:fx.r17.ownerFile};
  await assert.rejects(loadR18Anchor(wrong,null,fx.now));
  const anchorOriginal=await readFile(fx.anchorFile,'utf8');
  await writeFile(fx.anchorFile,JSON.stringify({...fx.anchor,registryRevision:55}),{mode:0o600});
  await assert.rejects(loadR18Anchor(fx.env,null,fx.now));
  await writeFile(fx.anchorFile,anchorOriginal,{mode:0o600});
});
test('R18 portable proof is independently verifiable; altered, stale, or cross-key proof is refused',async t=>{
  const {fx,keys}=await setup(t);
  const {proof,report}=await exportProof(fx.env,fx.now);
  assert.equal(report.valid,true,report.blockers.join(','));
  assert.equal(report.anchorDigest,(await loadR18Anchor(fx.env,null,fx.now)).anchorDigest);
  assert.equal(proof.records.registry.schema,'osmanx.guest.r16.registry.v1');
  assert.equal(proof.records.journal.schema,'osmanx.guest.r17.journal.v1');
  assert.equal(proof.records.anchor.role,'custodian');
  assert.equal(JSON.stringify(proof).includes('PRIVATE KEY'),false);
  const path=join(fx.root,'portable.json');
  await writeFile(path,JSON.stringify(proof),{mode:0o600});
  assert.equal((await verifyProofFile(path,fx.env,fx.now)).valid,true);
  const opts={now:fx.now,releaseCommit:fx.env.GUEST_RELEASE_COMMIT,
    minRevision:1,minSequence:3};
  assert.equal(verifyPortableProof(proof,keys,opts).valid,true);
  assert.equal(verifyPortableProof({...proof,bundleDigest:'0'.repeat(64)},
    keys,opts).valid,false);
  assert.equal(verifyPortableProof({...proof,records:{
    ...proof.records,anchor:{...proof.records.anchor,journalSequence:4}
  }},keys,opts).valid,false);
  assert.equal(verifyPortableProof(proof,{...keys,custodian:keys.witnessOwner},
    opts).valid,false);
  assert.equal(verifyPortableProof(proof,keys,{...opts,minSequence:4}).valid,false);
  assert.equal(verifyPortableProof(proof,keys,{...opts,
    now:new Date(fx.now.getTime()+3*3600000)}).valid,false);
});
test('R18 recovery rehearsal reads isolated DR fence and append-only receipts; never writes',async t=>{
  const {fx}=await setup(t);
  const {report:proof}=await exportProof(fx.env,fx.now);
  const queries=[];
  const client={
    query:async(sql)=>{
      queries.push(sql);
      if(sql==='BEGIN READ ONLY'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
      if(sql.includes('current_database()'))return {rowCount:1,rows:[{name:'industry_dr_r18_ci'}]};
      if(sql.includes('schema_migrations'))return {rowCount:1,rows:[{n:1}]};
      if(sql.includes('industry.guest_registry_checkpoint_fence'))return {
        rowCount:1,rows:[{max_revision:1,max_sequence:3,checkpoint_sha:proof.checkpointDigest}]
      };
      if(sql.includes('industry.guest_external_anchor_fence'))return {
        rowCount:1,rows:[{max_revision:1,max_sequence:3,
          checkpoint_sha:proof.checkpointDigest,anchor_sha:proof.anchorDigest}]
      };
      if(sql.includes('industry.guest_external_anchor_receipts'))return {
        rowCount:1,rows:[{registry_revision:1,journal_sequence:3,
          checkpoint_sha:proof.checkpointDigest,anchor_sha:proof.anchorDigest}]
      };
      throw Error('Unexpected SQL in recovery rehearsal');
    },
    release:()=>{}
  };
  const pool={connect:async()=>client};
  const proofVerifier=async()=>proof;
  const r=await rehearseRecovery({pool,proofVerifier,now:fx.now});
  assert.equal(r.technicalRestoreReady,true,JSON.stringify(r.blockers));
  assert.equal(r.customerGo,false);
  assert.equal(r.productionChanged,false);
  assert.equal(r.offsiteRetentionVerified,false);
  assert.ok(queries.every(q=>q==='BEGIN READ ONLY'||q==='ROLLBACK'||q.startsWith('SELECT')));
  const old=client.query;
  client.query=async sql=>{
    if(sql.includes('guest_external_anchor_fence'))return {
      rowCount:1,rows:[{max_revision:1,max_sequence:2,
        checkpoint_sha:proof.checkpointDigest,anchor_sha:proof.anchorDigest}]};
    return old(sql);
  };
  const stale=await rehearseRecovery({pool,proofVerifier,now:fx.now});
  assert.equal(stale.technicalRestoreReady,false);
  assert.ok(stale.blockers.includes('r18_restore_anchor_mismatch'));
  client.query=async sql=>sql.includes('current_database()')?
    {rowCount:1,rows:[{name:'industry_ci'}]}:old(sql);
  assert.equal((await rehearseRecovery({pool,proofVerifier,now:fx.now}))
    .technicalRestoreReady,false);
});
test('R18 stacked release gate refuses any open/unverified/human-unapproved PR',()=>{
  const empty=evaluateReleaseChain();
  assert.equal(empty.technicalReleaseReady,false);
  assert.ok(empty.blockers.includes('unmerged_pr_47'));
  const pulls={},checks={};
  for(const spec of CHAIN){
    pulls[spec.number]={number:spec.number,base:{ref:spec.base},
      head:{sha:spec.sha},merged:true,state:'closed',merged_at:'2026-11-19T00:00:00Z'};
    checks[spec.number]=spec.requiredChecks.map(name=>({
      name,head_sha:spec.sha,status:'completed',conclusion:'success'
    }));
  }
  const manual={externalArchiveRetained:true,encryptedDrRestored:true,
    independentLegalApproval:true,twoPersonOperationsApproval:true,
    customerContractVerified:true,productionChangeWindowApproved:true};
  const cleared=evaluateReleaseChain({pulls,checks,manual});
  assert.equal(cleared.technicalReleaseReady,true);
  assert.equal(cleared.productionActivated,false);
  assert.equal(cleared.customerGo,false);
  pulls[48].merged=false;
  assert.equal(evaluateReleaseChain({pulls,checks,manual}).technicalReleaseReady,false);
  pulls[48].merged=true;checks[51][0].conclusion='failure';
  assert.equal(evaluateReleaseChain({pulls,checks,manual}).technicalReleaseReady,false);
});
