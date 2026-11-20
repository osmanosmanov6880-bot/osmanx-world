/**
 * R42 local-only encrypted backup. Explicit operator intent + secure owned
 * output directory; never creates directories, invokes PG or holds credentials.
 * Does not authorize a backup of production or a connected customer DB.
 */
import {resolve,isAbsolute,sep} from 'node:path';
export const R42_BACKUP_SCHEMA='osmanx.guest.r42.local-backup-preflight.v1';
const DB=/^(?:industry_ci|guest_r14_canary|industry_dr_[a-z0-9_]{6,48})$/;
const PUB=/^age1[0-9a-z]{35,90}$/;
const ACK='CONFIRM_LOCAL_ENCRYPTED_BACKUP_NO_CUSTOMERS';
export function inspectR42BackupSource({dbUrl,recipient1,recipient2,
  acknowledgment}={}){
  const blockers=[];
  let database=null;
  try{
    const x=new URL(dbUrl);
    database=decodeURIComponent(x.pathname.slice(1));
    if(!['postgres:','postgresql:'].includes(x.protocol)||
      !['localhost','127.0.0.1','[::1]'].includes(x.hostname)||
      (x.port!==''&&x.port!=='5432')||
      !x.username||!x.password||x.search||x.hash||!DB.test(database))
      blockers.push('BACKUP_SOURCE_NOT_EXPLICIT_LOCAL_SYNTHETIC_DB');
  }catch{blockers.push('INVALID_POSTGRES_BACKUP_URL')}
  if(acknowledgment!==ACK)
    blockers.push('MISSING_OPERATOR_BACKUP_ACKNOWLEDGEMENT');
  if(!PUB.test(recipient1||'')||!PUB.test(recipient2||'')||
    recipient1===recipient2)
    blockers.push('TWO_DISTINCT_AGE_RECIPIENTS_REQUIRED');
  return {schema:R42_BACKUP_SCHEMA,valid:blockers.length===0,
    database:blockers.length===0?database:null,
    operatorAcknowledgmentPresent:acknowledgment===ACK,
    actualDbQueried:false,customerGo:false,
    productionAuthorized:false,blockers:[...new Set(blockers)]};
}
export function inspectR42BackupDirectory({
  path,canonical,checkout,stat,currentUid
}={}){
  const blockers=[];
  if(typeof path!=='string'||!isAbsolute(path)||
    typeof canonical!=='string'||!isAbsolute(canonical)||
    typeof checkout!=='string'||!isAbsolute(checkout)||
    path.length>2048||path.includes('\0'))
    blockers.push('DESTINATION_MUST_BE_ABSOLUTE_PRIVATE_DIR');
  const lexical=typeof path==='string'?resolve(path):'';
  const actual=typeof canonical==='string'?resolve(canonical):'';
  const root=typeof checkout==='string'?resolve(checkout):'';
  if(lexical!==actual||actual===root||actual.startsWith(root+sep))
    blockers.push('DESTINATION_IS_SYMLINK_OR_CHECKOUT');
  if(!stat?.isDirectory?.()||stat?.isSymbolicLink?.()||
    !Number.isInteger(stat.mode)||(stat.mode&0o077)!==0)
    blockers.push('DESTINATION_NOT_OWNER_PRIVATE');
  if(typeof currentUid==='number'&&stat?.uid!==currentUid)
    blockers.push('DESTINATION_NOT_OWNED_BY_OPERATOR');
  return {schema:'osmanx.guest.r42.private-backup-directory.v1',
    valid:blockers.length===0,blockers:[...new Set(blockers)],
    pathReturned:false,secretsReturned:false,
    productionAuthorized:false};
}
