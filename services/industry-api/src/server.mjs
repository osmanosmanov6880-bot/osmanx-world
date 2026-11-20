import {makePool} from './database.mjs';
import {buildApp} from './app.mjs';
import {probeGuestDatabase} from './readiness.mjs';
import {registerR38BuildHealth} from './guest-r38-build-route.mjs';

const pool=makePool();
let app;
const host=process.env.BIND_HOST||'127.0.0.1';
const port=Number(process.env.PORT||3047);
const close=async()=>{if(app)await app.close();await pool.end();process.exit(0)};
process.once('SIGINT',close);
process.once('SIGTERM',close);
try{
  // R10 production invariant: do not expose even a "healthy" listener on a stale schema,
  // elevated runtime DB account or disabled RLS. Credentials are never printed.
  if(process.env.NODE_ENV==='production')await probeGuestDatabase(pool);
  app=await buildApp(pool);
  registerR38BuildHealth(app);
  await app.listen({host,port});
  console.log('OSMANX INDUSTRY API listening on '+host+':'+port+
    ' (readiness verified; Guest writes '+(process.env.GUEST_WRITES_ENABLED==='true'?'operator-enabled':'disabled')+')');
}catch(error){
  console.error('Industry API start refused: database and security readiness not confirmed');
  if(app)await app.close().catch(()=>{});
  await pool.end().catch(()=>{});
  process.exitCode=1;
}
