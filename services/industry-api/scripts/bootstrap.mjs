import pg from 'pg';
import { hashPassword } from '../src/password.mjs';
const { MIGRATION_DB_URL, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, BOOTSTRAP_TENANT_SLUG, BOOTSTRAP_TENANT_NAME, BOOTSTRAP_VERTICAL } = process.env;
if (!MIGRATION_DB_URL || !BOOTSTRAP_EMAIL || !BOOTSTRAP_PASSWORD || !BOOTSTRAP_TENANT_SLUG || !BOOTSTRAP_TENANT_NAME || !BOOTSTRAP_VERTICAL) throw Error('Require MIGRATION_DB_URL and BOOTSTRAP_* variables');
const allowed=new Set(['lab','dental','auto','beauty','fitness','cafe','cleaning']);
if (!allowed.has(BOOTSTRAP_VERTICAL) || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(BOOTSTRAP_TENANT_SLUG)) throw Error('Invalid tenant');
const client = new pg.Client({connectionString:MIGRATION_DB_URL});
try {
  await client.connect();
  await client.query('BEGIN');
  const tenant = (await client.query('INSERT INTO industry.tenants(slug,name,vertical) VALUES ($1,$2,$3) ON CONFLICT (slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id',
    [BOOTSTRAP_TENANT_SLUG, BOOTSTRAP_TENANT_NAME, BOOTSTRAP_VERTICAL])).rows[0];
  const password = await hashPassword(BOOTSTRAP_PASSWORD);
  const email = BOOTSTRAP_EMAIL.toLowerCase().trim();
  const account = (await client.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id',[email,password])).rows[0];
  await client.query("INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'owner') ON CONFLICT (tenant_id,account_id) DO NOTHING",[tenant.id,account.id]);
  await client.query("INSERT INTO industry.resources(tenant_id,name) SELECT $1,'Общий календарь' WHERE NOT EXISTS(SELECT 1 FROM industry.resources WHERE tenant_id=$1)",[tenant.id]);
  await client.query('COMMIT');
  console.log('Bootstrap completed for tenant', BOOTSTRAP_TENANT_SLUG, '(no secrets printed)');
} catch (error) {
  await client.query('ROLLBACK').catch(()=>{});
  console.error('Bootstrap failed:',error.message);
  process.exitCode=1;
} finally { await client.end(); }
