/**
 * Bounded structural review packet for PR #47. Human reviewers inspect the
 * full patch; path heuristics are NOT a vulnerability scan or approval.
 */
import {createHash} from 'node:crypto';
export const R36_PATCH_SCHEMA='osmanx.guest.r36.first-pr-review-inventory.v1';
const EXPECTED=47;
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const SAFE=/^(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/;
const areas=[
  ['DEPLOY_AND_RUNTIME',/^services\/industry-api\/ops\//,
    'Проверить docker-compose isolation, loopback binding, rollback and operator confirmation'],
  ['CRYPTO_AND_GATE',/^services\/industry-api\/scripts\/r14-admission\.mjs$/,
    'Проверить доверенные ключи, подписи, срок действия и разделение ролей'],
  ['MONITOR_AND_INCIDENT',/^services\/industry-api\/scripts\/r14-(monitor|incident)\.mjs$/,
    'Проверить GET-only, приватность и fail-closed обработку недоступности'],
  ['CI_WORKFLOW',/^\.github\/workflows\//,
    'Проверить права CI, неизменность main и отсутствие секретов в логах'],
  ['TESTS',/\/test\/|\/tests\//,
    'Проверить негативные сценарии безопасности на чистой среде'],
  ['RELEASE_DOCS',/^docs\//,
    'Сверить документацию с командами и реальными ограничениями']
];
export function inspectR36FirstPrFiles({pr,files,complete=false}={}){
  const errors=[];
  if(pr?.number!==EXPECTED||pr?.draft!==true||
    pr?.state!=='open'||pr?.merged===true)
    errors.push('FIRST_PR_STATE_HAS_CHANGED');
  if(!Array.isArray(files)||files.length<1||files.length>2000||
    complete!==true)errors.push('INCOMPLETE_FILE_INVENTORY');
  const names=new Set(),items=[],risks=new Set();
  for(const f of Array.isArray(files)?files.slice(0,2000):[]){
    if(typeof f?.filename!=='string'||f.filename.length>220||
      !SAFE.test(f.filename)||f.filename.includes('..')||
      !['added','modified','removed','renamed'].includes(f.status)||
      !Number.isSafeInteger(f.additions)||f.additions<0||
      !Number.isSafeInteger(f.deletions)||f.deletions<0){
      errors.push('UNSAFE_OR_INVALID_FILE_METADATA');continue;
    }
    if(names.has(f.filename))errors.push('DUPLICATE_FILE');
    names.add(f.filename);
    const groups=areas.filter(a=>a[1].test(f.filename));
    for(const g of groups)risks.add(g[0]);
    const binaryOrTruncated=typeof f.patch!=='string'||
      f.patch.length===0||f.patch.length>65536;
    if(binaryOrTruncated)errors.push('PATCH_MISSING_OR_TRUNCATED');
    items.push({path:f.filename,status:f.status,
      additions:f.additions,deletions:f.deletions,
      patchSha256:binaryOrTruncated?null:sha(f.patch),
      reviewGroups:groups.map(g=>g[0])});
  }
  if(!items.some(x=>x.path==='services/industry-api/ops/compose.r14.yml'))
    errors.push('EXPECTED_CANARY_SOURCE_MISSING');
  const checklist=areas.filter(a=>risks.has(a[0]))
    .map(a=>({area:a[0],reviewPrompt:a[2]}));
  const body={schema:R36_PATCH_SCHEMA,pr:EXPECTED,
    expectedHeadSha:pr?.head?.sha||null,
    files:items.sort((a,b)=>a.path.localeCompare(b.path,'en')),
    checklist,changeCount:items.length,
    completeInventory:complete&&errors.length===0,
    humanCodeAuditPerformed:false,approvalSubmitted:false,
    mainChanged:false,productionAuthorized:false,
    findings:[...new Set(errors)]};
  return {...body,packetSha256:sha(body)};
}
