/**
 * Must be run by the backup shell itself BEFORE pg_dump or age invocation.
 */
import {lstat,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectR42BackupSource,inspectR42BackupDirectory}
  from '../src/guest-r42-backup-guard.mjs';
const root=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
export async function preflightR42Backup({
  destination,
  dbUrl=process.env.BACKUP_DB_URL,
  recipient1=process.env.AGE_RECIPIENT_1,
  recipient2=process.env.AGE_RECIPIENT_2,
  acknowledgment=process.env.GUEST_R42_BACKUP_ACK
}={}){
  const source=inspectR42BackupSource({dbUrl,recipient1,recipient2,
    acknowledgment});
  if(!source.valid)throw Error('R42_BACKUP_SOURCE_REJECTED');
  const [stat,canonical,checkout]=await Promise.all([
    lstat(destination),realpath(destination),realpath(root)
  ]);
  const dest=inspectR42BackupDirectory({
    path:destination,canonical,checkout,stat,
    currentUid:process.getuid?.()
  });
  if(!dest.valid)throw Error('R42_BACKUP_DESTINATION_REJECTED');
  return {schema:'osmanx.guest.r42.backup-operator-no-go.v1',
    valid:true,sourceVerified:true,destinationVerified:true,
    sourceUrlReturned:false,recipientKeysReturned:false,
    database:source.database,destinationPathReturned:false,
    actualPgDumpExecuted:false,customerGo:false,productionAuthorized:false};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3)throw Error('One private destination required');
    process.stdout.write(JSON.stringify(await preflightR42Backup({
      destination:process.argv[2]
    }))+'\n');
  }catch{
    process.stderr.write('R42 backup preflight NO-GO\n');process.exitCode=2;
  }
}
