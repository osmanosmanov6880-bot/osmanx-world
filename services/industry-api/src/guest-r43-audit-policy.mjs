/**
 * R43 npm advisory transport and severity policy. UNKNOWN advisory status
 * fails closed; a clean lock's SHA-512 entries do not prove zero CVEs.
 */
export const R43_AUDIT_SCHEMA='osmanx.guest.r43.npm-advisory-policy.v1';
const FIELDS=['critical','high','moderate','low','info'];
export function inspectR43Audit(report){
 const blockers=[];
 if(!report||typeof report!=='object'||Array.isArray(report)||
   report.error||report.auditReportVersion!==2||
   !report.metadata||!report.metadata.vulnerabilities||
   typeof report.vulnerabilities!=='object')
   blockers.push('NPM_ADVISORY_API_UNAVAILABLE_OR_MALFORMED');
 const severity={};
 for(const name of FIELDS){
   const n=report?.metadata?.vulnerabilities?.[name];
   if(!Number.isSafeInteger(n)||n<0)
     blockers.push('ADVISORY_SEVERITY_COUNTER_MISSING');
   severity[name]=Number.isSafeInteger(n)&&n>=0?n:null;
 }
 const findings=report?.vulnerabilities||{};
 if(!findings||typeof findings!=='object'||Array.isArray(findings)||
   Object.keys(findings).length>1000)
   blockers.push('ADVISORY_FINDING_INDEX_UNTRUSTED');
 else{
   for(const [pkg,entry] of Object.entries(findings)){
     if(!/^(?:@[-a-z0-9._]+\/)?[-a-z0-9._]+$/.test(pkg)||
       !entry||typeof entry!=='object'||
       !FIELDS.includes(entry.severity))
       blockers.push('INVALID_ADVISORY_RECORD');
   }
 }
 if((severity.critical??1)>0||(severity.high??1)>0)
   blockers.push('HIGH_OR_CRITICAL_DEPENDENCY_VULNERABILITIES');
 const reportChecked=blockers.length===0;
 return {schema:R43_AUDIT_SCHEMA,reportChecked,
   registryAuditExecuted:reportChecked,
   high:severity.high,critical:severity.critical,
   moderate:severity.moderate,low:severity.low,info:severity.info,
   manualReviewForNonHighFindings:
     (severity.moderate??0)+(severity.low??0)+(severity.info??0)>0,
   highCriticalPolicyPassed:reportChecked,
   advisorySourceClaimOnly:true,
   productionAuthorized:false,customerGo:false,
   blockers:[...new Set(blockers)]};
}
