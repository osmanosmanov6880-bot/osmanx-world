/** Offline D1 SQLite export verifier. NEVER contacts Cloudflare or prints row data/PII. */
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const required=['leads','subscriptions','editorial_draft','editorial_live','media_assets','episode_calendar','stream_visibility'];
export function verifyD1Export(sql,{requireR5=true}={}){
 if(typeof sql!=='string'||sql.length<100||sql.length>100*1024*1024)throw Error('Invalid SQL export size');
 const db=new DatabaseSync(':memory:');
 try{db.exec(sql);const integrity=db.prepare('PRAGMA integrity_check').all();const fk=db.prepare('PRAGMA foreign_key_check').all();const existing=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));
 const missing=required.filter(x=>!existing.has(x)&& (requireR5||x!=='stream_visibility'));
 if(integrity.length!==1||integrity[0].integrity_check!=='ok'||fk.length||missing.length)throw Error('D1 restore invalid: '+missing.join(', ')+(fk.length?' foreign keys failed':' integrity failure'));
 const counts={};for(const table of required.filter(x=>existing.has(x)))counts[table]=Number(db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get().n);
 return {ok:true,tablesChecked:Object.keys(counts).length,rowCounts:counts,integrity:'ok',foreignKeys:'ok',piiExposed:false};
 }finally{db.close();}
}
export function syntheticDrill(){const migrations=['0001_init.sql','0002_r3_editorial.sql','0003_r4_operations.sql','0004_r5_visibility.sql'].map(n=>readFileSync(new URL('../services/moscow-1000-api/migrations/'+n,import.meta.url),'utf8')).join('\n');
 const sample="INSERT INTO stream_visibility(uid,desired,state,attempts,reason,updated_at) VALUES('"+'a'.repeat(32)+"','private','applied',0,'synthetic-drill','2026-01-01T00:00:00Z');";
 return verifyD1Export(migrations+'\n'+sample);}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const file=process.argv[2];const result=file?verifyD1Export(readFileSync(file,'utf8')):syntheticDrill();console.log('R5 D1 restore drill passed. Only aggregate counts are reported:',JSON.stringify(result));}catch(e){console.error('R5 D1 restore drill BLOCKED:',e.message);process.exitCode=1;}}
