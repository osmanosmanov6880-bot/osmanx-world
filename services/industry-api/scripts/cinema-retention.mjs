// Operator-run CLI. Does not run in web requests or without explicit private opt-in.
import {makePool} from '../src/database.mjs';
import {sweepCinemaTenant} from '../src/cinema-retention.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function requireConfiguration(env=process.env){
  if(env.CINEMA_RETENTION_ENABLED!=='true')throw Error('CINEMA_RETENTION_ENABLED must be explicitly true');
  if(!UUID.test(env.CINEMA_TENANT_ID||''))throw Error('CINEMA_TENANT_ID must be a configured tenant UUID');
  if(!env.DATABASE_URL)throw Error('DATABASE_URL required: use least-privilege Industry OS app role');
  // Retention MUST keep running after a public-intake rollback; existing records still expire.
  return env.CINEMA_TENANT_ID;
}
export {requireConfiguration};
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  let pool;
  try {
    const tenant=requireConfiguration();
    pool=makePool();
    const summary=await sweepCinemaTenant(pool,tenant);
    console.log(JSON.stringify({status:'success',...summary,tenant:tenant.slice(0,8)+'…'}));
  }catch(err){
    console.error('CINEMA retention did not complete:',err.statusCode||'blocked',String(err.message).replace(/postgresql:\/\/\S+/g,'[REDACTED]'));
    process.exitCode=1;
  }finally{if(pool)await pool.end();}
}
