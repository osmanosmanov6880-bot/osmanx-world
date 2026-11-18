// R7 independent DR proof for SYNTHETIC Guest pilot evidence.
// Never run against a non-loopback host, a production database, or live accounts.
import pg from 'pg';
import {createHash} from 'node:crypto';
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
export const EXPECTED_DIGEST=hash(expected);
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
      "INSERT INTO industry.guest_pilots(tenant_id,created_by,title,phase,plan,readiness,target_per_group,version,submitted_by,reviewed_by,submitted_digest,reviewed_at,archived_at,archived_by,archive_reason) VALUES($1,$2,'R7 synthetic archived proof','archived',$3::jsonb,$4::jsonb,700,5,$2,$5,$6,now(),now(),$2,'DR evidence verification') RETURNING id",
      [tenant,owner,JSON.stringify(plan),JSON.stringify(readiness),manager,EXPECTED_DIGEST]
    )).rows[0].id;
    for(const row of observations){
      await db.query(
        "INSERT INTO industry.guest_observations(tenant_id,pilot_id,observed_on,control_count,control_return,offer_count,offer_return,idempotency_key,payload_digest,created_by) VALUES($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10)",
        [tenant,pilot,row.date,row.control,row.controlReturn,row.offer,row.offerReturn,
          'dr-r7-'+row.date,hash(row),owner]);
    }
    await db.query(
      "INSERT INTO industry.guest_reviews(tenant_id,pilot_id,actor_id,decision,evidence_digest) VALUES($1,$2,$3,'accept_for_discussion',$4)",
      [tenant,pilot,manager,EXPECTED_DIGEST]);
    await db.query(
      "INSERT INTO industry.audit_events(tenant_id,actor_id,action,target_id) VALUES($1,$2,'guest.pilot.archived',$3)",
      [tenant,owner,pilot]);
    await db.query(
      "INSERT INTO industry.outbox(tenant_id,kind,payload) VALUES($1,'guest.pilot.archived',$2::jsonb)",
      [tenant,JSON.stringify({event:'guest.pilot.archived',entityId:pilot})]);
    await db.query('COMMIT');
    return {ok:true,stage:'seed',proofSha256:EXPECTED_DIGEST};
  }catch(e){await db.query('ROLLBACK');throw e}
}
async function verify(db){
  const r=await db.query(
    "SELECT p.*,t.slug FROM industry.guest_pilots p JOIN industry.tenants t ON t.id=p.tenant_id WHERE t.slug='dr-r7-proof'"
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
  if(digest!==EXPECTED_DIGEST||pilot.submitted_digest!==digest)
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
    "SELECT count(*)::int AS n FROM industry.outbox WHERE tenant_id=$1 AND kind='guest.pilot.archived'",
    [pilot.tenant_id]);
  if(audits.rows[0].n!==1||events.rows[0].n!==1)throw Error('Audit or outbox missing');
  const policies=await db.query(
    "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='industry' AND c.relname=ANY($1::text[]) AND c.relrowsecurity AND c.relforcerowsecurity",
    [['guest_requests','guest_pilots','guest_observations','guest_reviews']]);
  if(policies.rows[0].n!==4)throw Error('Row-level security was not restored');
  const migration=await db.query(
    "SELECT count(*)::int AS n FROM industry.schema_migrations WHERE name='006_guest_readiness_permissions.sql'"
  );
  if(migration.rows[0].n!==1)throw Error('Latest migration version not restored');
  return {ok:true,stage:'verify',observations:rows.rowCount,
    reviewedIndependently:true,proofSha256:digest,forcedRls:true};
}
if(process.argv[1]?.endsWith('/dr-guest-proof.mjs')){
  const [mode]=process.argv.slice(2),url=process.env.R7_DR_DB_URL;
  if(!url)throw Error('R7_DR_DB_URL is required');
  const result=await run(mode,url);
  process.stdout.write(JSON.stringify(result)+'\n');
}
