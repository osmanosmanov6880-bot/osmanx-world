// R7 independent DR proof for SYNTHETIC Guest pilot evidence.
// Never run against a non-loopback host, a production database, or live accounts.
import pg from 'pg';
import {createHash} from 'node:crypto';
import {batchDigest} from '../src/guest-bulk.mjs';
import {snapshotLaunch,launchPreflight} from '../src/guest-launch.mjs';
const hash=obj=>createHash('sha256').update(JSON.stringify(obj)).digest('hex');
const plan={baselinePct:20,liftPp:10,margin:300,discount:5,fixed:1000,fee:25000};
const readiness={repeatDefinition:true,sameWindow:true,independentGroups:true,
  marginVerified:true,contactConsent:true,ownerAgreed:true};
const observations=[
  {date:'2026-11-09',control:700,controlReturn:140,offer:700,offerReturn:210},
  {date:'2026-11-16',control:700,controlReturn:140,offer:700,offerReturn:210}
];
const expected={
  schema:'osmanx.guest.evidence.v1',
  plan,readiness,targetPerGroup:700,observations
};
// The authoritative hash is computed from PostgreSQL's JSONB serialization at seed time.
export function assertTarget(value,mode){
  if(!['seed','verify'].includes(mode))throw Error('Use seed or verify');
  const u=new URL(value);
  const db=decodeURIComponent(u.pathname.slice(1));
  if(!['postgres:','postgresql:'].includes(u.protocol)||
    !['127.0.0.1','localhost'].includes(u.hostname)||u.port!=='5432'||
    u.search||u.hash||u.username.length===0)
    throw Error('Only a loopback PostgreSQL CI target is allowed');
  if(mode==='seed' && db!=='industry_ci')throw Error('Seed is restricted to industry_ci');
  if(mode==='verify'&&!/^industry_dr_[a-z0-9_]+$/.test(db))
    throw Error('Verify is restricted to industry_dr_*');
}
export async function run(mode,url){
  if(process.env.NODE_ENV==='production')throw Error('Production use is forbidden');
  assertTarget(url,mode);
  const client=new pg.Client({connectionString:url});
  await client.connect();
  try{
    if(mode==='seed')return await seed(client);
    return await verify(client);
  }finally{await client.end()}
}
async function seed(db){
  await db.query('BEGIN');
  try{
    const tenant=(await db.query(
      "INSERT INTO industry.tenants(slug,name,vertical) VALUES('dr-r7-proof','R7 synthetic pilot recovery','cafe') RETURNING id"
    )).rows[0].id;
    const owner=(await db.query(
      "INSERT INTO industry.accounts(email,password_hash) VALUES('dr-r7-owner@example.test','synthetic-never-login') RETURNING id"
    )).rows[0].id;
    const manager=(await db.query(
      "INSERT INTO industry.accounts(email,password_hash) VALUES('dr-r7-reviewer@example.test','synthetic-never-login') RETURNING id"
    )).rows[0].id;
    await db.query(
      "INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'owner'),($1,$3,'manager')",
      [tenant,owner,manager]);
    const pilot=(await db.query(
      "INSERT INTO industry.guest_pilots(tenant_id,created_by,title,phase,plan,readiness,target_per_group,version,submitted_by,reviewed_by,reviewed_at,archived_at,archived_by,archive_reason) VALUES($1,$2,'R7 synthetic archived proof','archived',$3::jsonb,$4::jsonb,700,5,$2,$5,now(),now(),$2,'DR evidence verification') RETURNING id",
      [tenant,owner,JSON.stringify(plan),JSON.stringify(readiness),manager]
    )).rows[0].id;
    for(const row of observations){
      await db.query(
        "INSERT INTO industry.guest_observations(tenant_id,pilot_id,observed_on,control_count,control_return,offer_count,offer_return,idempotency_key,payload_digest,created_by) VALUES($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10)",
        [tenant,pilot,row.date,row.control,row.controlReturn,row.offer,row.offerReturn,
          'dr-r7-'+row.date,hash(row),owner]);
    }
    const saved=(await db.query('SELECT plan,readiness,target_per_group FROM industry.guest_pilots WHERE id=$1',[pilot])).rows[0];
    const originalHash=hash({schema:'osmanx.guest.evidence.v1',plan:saved.plan,
      readiness:saved.readiness,targetPerGroup:saved.target_per_group,observations});
    await db.query('UPDATE industry.guest_pilots SET submitted_digest=$1 WHERE id=$2',[originalHash,pilot]);
    await db.query(
      "INSERT INTO industry.guest_reviews(tenant_id,pilot_id,actor_id,decision,evidence_digest) VALUES($1,$2,$3,'accept_for_discussion',$4)",
      [tenant,pilot,manager,originalHash]);
    // R9 disaster recovery also proves the new auditable action and batch import ledgers.
    const task=(await db.query(
      "INSERT INTO industry.guest_actions(tenant_id,pilot_id,code,status,assigned_to,created_by,due_on,version) VALUES($1,$2,'REVIEW_CONTROLLED_FOLLOWUP','done',$3,$4,'2026-11-16'::date,3) RETURNING id",
      [tenant,pilot,manager,owner])).rows[0].id;
    // R11 synthetic event is an imported baseline, not a forged R9 transition log.
    await db.query(
      "INSERT INTO industry.guest_action_history(tenant_id,pilot_id,action_id,actor_id,event_type,to_status,next_assignee,next_due_on,action_version) VALUES($1,$2,$3,$4,'baseline','done',$5,'2026-11-16'::date,3)",
      [tenant,pilot,task,owner,manager]
    );
    const recoveredImportHash=batchDigest(pilot,3,observations);
    const imported=(await db.query(
      "INSERT INTO industry.guest_bulk_imports(tenant_id,pilot_id,idempotency_key,payload_digest,rows_imported,committed_version,created_by) VALUES($1,$2,'r9-dr-legacy-import',$3,2,4,$4) RETURNING id",
      [tenant,pilot,recoveredImportHash,owner])).rows[0].id;
    await db.query(
      "INSERT INTO industry.audit_events(tenant_id,actor_id,action,target_id) VALUES($1,$2,'guest.action.done',$3),($1,$2,'guest.observations.batch_imported',$4)",
      [tenant,owner,task,pilot]);
    await db.query(
      "INSERT INTO industry.outbox(tenant_id,kind,payload) VALUES($1,'guest.action.done',$2::jsonb),($1,'guest.observations.batch_imported',$3::jsonb)",
      [tenant,JSON.stringify({event:'guest.action.done',entityId:task}),JSON.stringify({event:'guest.observations.batch_imported',entityId:pilot,batchId:imported})]);
    await db.query(
      "INSERT INTO industry.audit_events(tenant_id,actor_id,action,target_id) VALUES($1,$2,'guest.pilot.archived',$3)",
      [tenant,owner,pilot]);
    await db.query(
      "INSERT INTO industry.outbox(tenant_id,kind,payload) VALUES($1,'guest.pilot.archived',$2::jsonb)",
      [tenant,JSON.stringify({event:'guest.pilot.archived',entityId:pilot})]);
    // R10: a second, protocol-bound v2 archive demonstrates that future restores
    // retain both historic v1 and new immutable protocol-based evidence.
    const modernProtocol={
      startDate:'2026-11-01',endDate:'2026-11-16',outcomeWindowDays:1,
      allocation:'random',source:'pos',primaryMetric:'repeat_visit'
    };
    const modernObservations=[
      {date:'2026-11-10',control:900,controlReturn:180,offer:900,offerReturn:270},
      {date:'2026-11-11',control:900,controlReturn:180,offer:900,offerReturn:270}
    ];
    const modern=(await db.query(
      "INSERT INTO industry.guest_pilots(tenant_id,created_by,title,phase,plan,readiness,target_per_group,protocol,protocol_registered_at,version,submitted_by,reviewed_by,reviewed_at,archived_at,archived_by,archive_reason) VALUES($1,$2,'R10 synthetic v2 proof','archived',$3::jsonb,$4::jsonb,700,$5::jsonb,'2026-11-12T00:00:00.000Z'::timestamptz,5,$2,$6,now(),now(),$2,'R10 DR v2 evidence verification') RETURNING id",
      [tenant,owner,JSON.stringify(plan),JSON.stringify(readiness),
        JSON.stringify(modernProtocol),manager]
    )).rows[0].id;
    for(const row of modernObservations){
      await db.query(
        "INSERT INTO industry.guest_observations(tenant_id,pilot_id,observed_on,control_count,control_return,offer_count,offer_return,idempotency_key,payload_digest,created_by) VALUES($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10)",
        [tenant,modern,row.date,row.control,row.controlReturn,row.offer,row.offerReturn,
          'r10-v2-'+row.date,hash(row),owner]
      );
    }
    const modernSaved=(await db.query(
      "SELECT plan,readiness,target_per_group,protocol,protocol_registered_at FROM industry.guest_pilots WHERE id=$1",
      [modern])).rows[0];
    const modernHash=hash({
      schema:'osmanx.guest.evidence.v2',plan:modernSaved.plan,
      readiness:modernSaved.readiness,targetPerGroup:modernSaved.target_per_group,
      protocol:modernSaved.protocol,protocolRegisteredAt:modernSaved.protocol_registered_at,
      observations:modernObservations
    });
    await db.query('UPDATE industry.guest_pilots SET submitted_digest=$1 WHERE id=$2',
      [modernHash,modern]);
    await db.query(
      "INSERT INTO industry.guest_reviews(tenant_id,pilot_id,actor_id,decision,evidence_digest) VALUES($1,$2,$3,'accept_for_discussion',$4)",
      [tenant,modern,manager,modernHash]);
    await db.query(
      "INSERT INTO industry.audit_events(tenant_id,actor_id,action,target_id) VALUES($1,$2,'guest.pilot.archived',$3)",
      [tenant,owner,modern]);
    await db.query(
      "INSERT INTO industry.outbox(tenant_id,kind,payload) VALUES($1,'guest.pilot.archived',$2::jsonb)",
      [tenant,JSON.stringify({event:'guest.pilot.archived',entityId:modern})]);
    // R12: a third, not-yet-launched synthetic pilot proves independent, expiring
    // human attestations survive TWO-key restore without changing historical v1/v2.
    const future=days=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
    const launchProtocol={
      startDate:future(2),endDate:future(11),outcomeWindowDays:1,
      allocation:'random',source:'pos',primaryMetric:'repeat_visit'
    };
    const launchPilot=(await db.query(
      "INSERT INTO industry.guest_pilots(tenant_id,created_by,title,phase,plan,readiness,target_per_group,protocol,protocol_registered_at,launch_gate_enrolled_at,version) VALUES($1,$2,'R12 synthetic pending two-person launch','draft',$3::jsonb,$4::jsonb,700,$5::jsonb,now(),now(),2) RETURNING *",
      [tenant,owner,JSON.stringify(plan),JSON.stringify(readiness),JSON.stringify(launchProtocol)]
    )).rows[0];
    const launchDigest=hash(snapshotLaunch(launchPilot));
    for(const [role,actor,key] of [
      ['owner',owner,'r12-dr-owner-proof'],
      ['manager',manager,'r12-dr-manager-proof']
    ])await db.query(
      "INSERT INTO industry.guest_launch_attestations(tenant_id,pilot_id,actor_id,role,snapshot_digest,pilot_version,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [tenant,launchPilot.id,actor,role,launchDigest,launchPilot.version,key]
    );
    await db.query('COMMIT');
    return {ok:true,stage:'seed',proofSha256:originalHash,
      proofSha256V2:modernHash,proofSha256R12:launchDigest};
  }catch(e){await db.query('ROLLBACK');throw e}
}
async function verify(db){
  const r=await db.query(
    "SELECT p.*,t.slug FROM industry.guest_pilots p JOIN industry.tenants t ON t.id=p.tenant_id WHERE t.slug='dr-r7-proof' AND p.title='R7 synthetic archived proof'"
  );
  if(r.rowCount!==1)throw Error('Missing or duplicated archived proof pilot');
  const pilot=r.rows[0];
  if(pilot.phase!=='archived'||!pilot.archived_at||pilot.archived_by!==pilot.created_by||
     !pilot.submitted_digest||pilot.reviewed_by===pilot.submitted_by)
    throw Error('Archive or independent review did not survive');
  const rows=await db.query(
    "SELECT observed_on::text AS date,control_count AS control,control_return AS \"controlReturn\",offer_count AS offer,offer_return AS \"offerReturn\" FROM industry.guest_observations WHERE tenant_id=$1 AND pilot_id=$2 AND voided_at IS NULL ORDER BY observed_on,id",
    [pilot.tenant_id,pilot.id]);
  if(rows.rowCount!==2)throw Error('Observation ledger missing after restore');
  const evidence={schema:'osmanx.guest.evidence.v1',plan:pilot.plan,
    readiness:pilot.readiness,targetPerGroup:pilot.target_per_group,observations:rows.rows};
  const digest=hash(evidence);
  const expectedDigest=process.env.R7_EXPECTED_DR_DIGEST;
  if(!/^[a-f0-9]{64}$/.test(String(expectedDigest||'')))throw Error('Expected original DR digest is required');
  if(digest!==expectedDigest||pilot.submitted_digest!==digest)
    throw Error('Recovery evidence digest differs from original');
  const review=await db.query(
    "SELECT actor_id,decision,evidence_digest FROM industry.guest_reviews WHERE tenant_id=$1 AND pilot_id=$2",
    [pilot.tenant_id,pilot.id]);
  if(review.rowCount!==1||review.rows[0].actor_id!==pilot.reviewed_by||
     review.rows[0].decision!=='accept_for_discussion'||review.rows[0].evidence_digest!==digest)
    throw Error('Independent approval or digest missing');
  const audits=await db.query(
    "SELECT count(*)::int AS n FROM industry.audit_events WHERE tenant_id=$1 AND target_id=$2 AND action='guest.pilot.archived'",
    [pilot.tenant_id,pilot.id]);
  const events=await db.query(
    "SELECT count(*)::int AS n FROM industry.outbox WHERE tenant_id=$1 AND kind='guest.pilot.archived' AND payload->>'entityId'=$2",
    [pilot.tenant_id,pilot.id]);
  if(audits.rows[0].n!==1||events.rows[0].n!==1)throw Error('Audit or outbox missing');
  const modernResult=await db.query(
    "SELECT * FROM industry.guest_pilots WHERE tenant_id=$1 AND title='R10 synthetic v2 proof'",
    [pilot.tenant_id]);
  if(modernResult.rowCount!==1)throw Error('Missing or duplicated R10 v2 proof');
  const modern=modernResult.rows[0];
  if(modern.phase!=='archived'||!modern.protocol||!modern.protocol_registered_at||
     modern.submitted_by===modern.reviewed_by||!modern.archived_at)
    throw Error('R10 v2 independent archive or immutable protocol not restored');
  const modernRows=await db.query(
    "SELECT observed_on::text AS date,control_count AS control,control_return AS \"controlReturn\",offer_count AS offer,offer_return AS \"offerReturn\" FROM industry.guest_observations WHERE tenant_id=$1 AND pilot_id=$2 AND voided_at IS NULL ORDER BY observed_on,id",
    [pilot.tenant_id,modern.id]);
  if(modernRows.rowCount!==2)throw Error('R10 v2 observation history missing');
  const v2Hash=hash({
    schema:'osmanx.guest.evidence.v2',plan:modern.plan,
    readiness:modern.readiness,targetPerGroup:modern.target_per_group,
    protocol:modern.protocol,protocolRegisteredAt:modern.protocol_registered_at,
    observations:modernRows.rows
  });
  const expectedV2=process.env.R10_EXPECTED_DR_DIGEST_V2;
  if(!/^[a-f0-9]{64}$/.test(String(expectedV2||''))||
     v2Hash!==expectedV2||modern.submitted_digest!==v2Hash)
    throw Error('R10 restored v2 digest differs from source or original proof');
  const modernReview=await db.query(
    "SELECT actor_id,decision,evidence_digest FROM industry.guest_reviews WHERE tenant_id=$1 AND pilot_id=$2",
    [pilot.tenant_id,modern.id]);
  if(modernReview.rowCount!==1||modernReview.rows[0].actor_id!==modern.reviewed_by||
     modernReview.rows[0].decision!=='accept_for_discussion'||
     modernReview.rows[0].evidence_digest!==v2Hash)
    throw Error('R10 reviewed-by-independent-manager evidence invalid');
  const policies=await db.query(
    "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='industry' AND c.relname=ANY($1::text[]) AND c.relrowsecurity AND c.relforcerowsecurity",
    [['guest_requests','guest_pilots','guest_observations','guest_reviews','guest_quotas','guest_actions','guest_bulk_imports','guest_action_history','guest_launch_attestations']]);
  if(policies.rows[0].n!==9)throw Error('Row-level security was not restored');
  const task=await db.query(
    "SELECT code,status,assigned_to,created_by,version,due_on::text AS due_date FROM industry.guest_actions WHERE tenant_id=$1 AND pilot_id=$2",
    [pilot.tenant_id,pilot.id]);
  if(task.rowCount!==1||task.rows[0].code!=='REVIEW_CONTROLLED_FOLLOWUP'||
     task.rows[0].status!=='done'||task.rows[0].version!==3||
     task.rows[0].assigned_to!==pilot.reviewed_by||task.rows[0].due_date!=='2026-11-16')
    throw Error('R9 action ledger not independently recovered');
  const history=await db.query(
    "SELECT event_type,to_status,actor_id,action_version,next_due_on::text AS due_date FROM industry.guest_action_history WHERE tenant_id=$1 AND pilot_id=$2",
    [pilot.tenant_id,pilot.id]);
  if(history.rowCount!==1||history.rows[0].event_type!=='baseline'||
     history.rows[0].to_status!=='done'||history.rows[0].actor_id!==pilot.created_by||
     history.rows[0].action_version!==3||history.rows[0].due_date!=='2026-11-16')
    throw Error('R11 append-only action baseline not restored');
  const importRow=await db.query(
    "SELECT payload_digest,rows_imported,committed_version FROM industry.guest_bulk_imports WHERE tenant_id=$1 AND pilot_id=$2",
    [pilot.tenant_id,pilot.id]);
  const expectedImportHash=batchDigest(pilot.id,3,rows.rows);
  if(importRow.rowCount!==1||importRow.rows[0].payload_digest!==expectedImportHash||
     importRow.rows[0].rows_imported!==2||importRow.rows[0].committed_version!==4)
    throw Error('R9 idempotent import proof did not recover');
  const actionAudit=await db.query(
    "SELECT count(*)::int AS n FROM industry.audit_events WHERE tenant_id=$1 AND action IN ('guest.action.done','guest.observations.batch_imported')",
    [pilot.tenant_id]);
  if(actionAudit.rows[0].n!==2)throw Error('R9 follow-up audit not recovered');
  const launchProof=await db.query(
    "SELECT * FROM industry.guest_pilots WHERE tenant_id=$1 AND title='R12 synthetic pending two-person launch'",
    [pilot.tenant_id]);
  if(launchProof.rowCount!==1||launchProof.rows[0].phase!=='draft'||
     !launchProof.rows[0].launch_gate_enrolled_at)
    throw Error('R12 launch gate enrollment missing after recovery');
  const launchPilot=launchProof.rows[0];
  const launchHistory=await db.query(
    "SELECT role,actor_id,snapshot_digest,accepted_at,expires_at,pilot_version FROM industry.guest_launch_attestations WHERE tenant_id=$1 AND pilot_id=$2 ORDER BY role",
    [pilot.tenant_id,launchPilot.id]);
  if(launchHistory.rowCount!==2||launchHistory.rows[0].role!=='manager'||
     launchHistory.rows[1].role!=='owner'||
     launchHistory.rows[0].actor_id===launchHistory.rows[1].actor_id)
    throw Error('Independent R12 human approvals were not restored');
  const digestR12=hash(snapshotLaunch(launchPilot));
  const expectedR12=process.env.R12_EXPECTED_DR_DIGEST;
  if(!/^[a-f0-9]{64}$/.test(String(expectedR12||''))||digestR12!==expectedR12||
     launchHistory.rows.some(r=>r.snapshot_digest!==digestR12||r.pilot_version!==launchPilot.version))
    throw Error('R12 attestation SHA or original version differs after recovery');
  const gate=launchPreflight({
    pilot:launchPilot,members:[
      {role:'owner',account_id:launchHistory.rows[1].actor_id,active:true},
      {role:'manager',account_id:launchHistory.rows[0].actor_id,active:true}
    ],attestations:launchHistory.rows
  });
  if(!gate.canStartIsolatedPilot||gate.customerProductionAuthorized!==false)
    throw Error('R12 restored signoffs are invalid or claimed production authorization');
  const migration=await db.query(
    "SELECT count(*)::int AS n FROM industry.schema_migrations WHERE name='010_guest_launch_gate.sql'"
  );
  if(migration.rows[0].n!==1)throw Error('Latest migration version not restored');
  return {ok:true,stage:'verify',observations:rows.rowCount,
    reviewedIndependently:true,proofSha256:digest,forcedRls:true,
    actionRecovered:true,actionHistoryRecovered:true,importRecovered:true,importSha256:expectedImportHash,
    v2ProofRecovered:true,proofSha256V2:v2Hash,
    launchProofRecovered:true,proofSha256R12:digestR12};
}
if(process.argv[1]?.endsWith('/dr-guest-proof.mjs')){
  const [mode]=process.argv.slice(2),url=process.env.R7_DR_DB_URL;
  if(!url)throw Error('R7_DR_DB_URL is required');
  const result=await run(mode,url);
  process.stdout.write(JSON.stringify(result)+'\n');
}
