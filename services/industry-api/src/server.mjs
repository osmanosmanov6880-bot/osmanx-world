import { makePool } from './database.mjs';
import { buildApp } from './app.mjs';
const pool=makePool();
const app=await buildApp(pool);
const host=process.env.BIND_HOST||'127.0.0.1';
const port=Number(process.env.PORT||3047);
const close=async()=>{await app.close();await pool.end();process.exit(0)};
process.once('SIGINT',close);
process.once('SIGTERM',close);
try{
  await app.listen({host,port});
  console.log('OSMANX INDUSTRY API ready on '+host+':'+port);
}catch(e){console.error('Start failed',e.message);await pool.end();process.exit(1)}
