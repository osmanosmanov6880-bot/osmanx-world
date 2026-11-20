/**
 * R38 direct (legacy) restore guard. Preserve synthetic r19/r22 recovery,
 * but refuse any remote/non-disposable database before touching PostgreSQL.
 */
import {isAbsolute} from 'node:path';
export const R38_DR_SCHEMA='osmanx.guest.r38.direct-disposable-restore.v1';
const DB=/^industry_dr_r[0-9]{2}_[a-z0-9_]{3,26}$/;
export function evaluateR38RestoreTarget({dbUrl,archive,key,
  archiveStat,keyStat,checksumStat}={}){
  const blockers=[];
  let dbName=null;
  try{
    const u=new URL(dbUrl);
    dbName=decodeURIComponent(u.pathname.slice(1));
    const hostname=u.hostname.replace(/^\[|\]$/g,'');
    if(!['postgres:','postgresql:'].includes(u.protocol)||
      !['localhost','127.0.0.1','::1'].includes(hostname)||
      !['','5432'].includes(u.port)||
      u.search||u.hash||!DB.test(dbName)||
      dbName.includes('production')||dbName.includes('live')||
      dbName.includes('prod'))
      blockers.push('NOT_LOCAL_DISPOSABLE_POSTGRES');
  }catch{blockers.push('INVALID_POSTGRES_URL')}
  if(typeof archive!=='string'||!isAbsolute(archive)||
    archive.length>1024||!archive.endsWith('.age')||archive.includes('\0'))
    blockers.push('BAD_AGE_ARCHIVE_PATH');
  if(typeof key!=='string'||!isAbsolute(key)||
    key.length>1024||key.includes('\0'))
    blockers.push('BAD_AGE_IDENTITY_PATH');
  if(!archiveStat?.isFile?.()||archiveStat.isSymbolicLink?.()||
    !Number.isSafeInteger(archiveStat.size)||
    archiveStat.size<128||archiveStat.size>128*1024*1024)
    blockers.push('AGE_ARCHIVE_NOT_REGULAR_BOUNDED');
  if(!checksumStat?.isFile?.()||checksumStat.isSymbolicLink?.()||
    !Number.isSafeInteger(checksumStat.size)||
    checksumStat.size<68||checksumStat.size>1024)
    blockers.push('SHA_SIDECAR_UNTRUSTED');
  if(!keyStat?.isFile?.()||keyStat.isSymbolicLink?.()||
    !Number.isSafeInteger(keyStat.size)||
    keyStat.size<16||keyStat.size>65536||
    !Number.isInteger(keyStat.mode)||(keyStat.mode&0o077)!==0)
    blockers.push('AGE_IDENTITY_PERMISSION_OR_TYPE');
  return {schema:R38_DR_SCHEMA,valid:blockers.length===0,
    targetDatabase:DB.test(dbName||'')?dbName:null,
    blockers:[...new Set(blockers)],
    archiveContentsReturned:false,identityBytesRead:false,
    postgresConnected:false,productionDatabaseTouched:false};
}
