/**
 * R44 audit policy rejects internally contradictory npm audit JSON.
 * npm audit is a point-in-time advisory feed, not a universal CVE guarantee.
 */
export const R44_AUDIT_SCHEMA='osmanx.guest.r44.strict-npm-audit.v1';
const SEVERITIES=['info','low','moderate','high','critical'];
const validObj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export function verifyR44NpmAudit(report,{expectedPackageCount=63}={}){
 const blockers=[];
 const summary=report?.metadata?.vulnerabilities;
 if(!validObj(report)||report.auditReportVersion!==2||report.error||
    !validObj(report.metadata)||!validObj(summary)||
    !validObj(report.vulnerabilities))
   blockers.push('AUDIT_RESPONSE_MALFORMED_OR_UNAVAILABLE');
 const counters={};let sum=0;
 for(const s of SEVERITIES){
   const n=summary?.[s];
   if(!Number.isSafeInteger(n)||n<0)
     blockers.push('AUDIT_MISSING_OR_INVALID_SEVERITY_COUNTER');
   else sum+=n;
   counters[s]=Number.isSafeInteger(n)&&n>=0?n:null;
 }
 if(summary?.total!==sum||!Number.isSafeInteger(summary?.total))
   blockers.push('AUDIT_TOTAL_DOES_NOT_MATCH_SEVERITY_COUNTERS');
 const findings=validObj(report?.vulnerabilities)?Object.entries(report.vulnerabilities):[];
 if(findings.length>expectedPackageCount)
   blockers.push('AUDIT_FINDING_COUNT_EXCEEDS_LOCKED_PACKAGES');
 const bySeverity=Object.fromEntries(SEVERITIES.map(s=>[s,0]));
 for(const [name,entry] of findings){
   if(!/^(?:@[-a-z0-9._]+\/)?[-a-z0-9._]+$/.test(name)||
      !validObj(entry)||!SEVERITIES.includes(entry.severity)||
      !Array.isArray(entry.via)||!Array.isArray(entry.effects)||
      !Array.isArray(entry.nodes)||typeof entry.isDirect!=='boolean')
      blockers.push('AUDIT_FINDING_SHAPE_UNTRUSTED');
   else bySeverity[entry.severity]++;
 }
 for(const severity of SEVERITIES){
   if(counters[severity]!==null&&bySeverity[severity]!==counters[severity])
     blockers.push('AUDIT_FINDING_COUNTER_MISMATCH');
 }
 if((counters.high??1)>0||(counters.critical??1)>0)
   blockers.push('UNRESOLVED_HIGH_OR_CRITICAL_ADVISORIES');
 if(!Number.isSafeInteger(expectedPackageCount)||expectedPackageCount<1)
   blockers.push('INVALID_LOCKED_PACKAGE_COUNT');
 const result={
   schema:R44_AUDIT_SCHEMA,valid:blockers.length===0,
   expectedPackageCount,listedFindings:findings.length,
   advisoryCounters:counters,
   completeConsistentAdvisoryEvidence:blockers.length===0,
   moderateOrLowerRequiresManualReview:
     (counters.moderate??0)+(counters.low??0)+(counters.info??0)>0,
   snapshotOnly:true,productionAuthorized:false,customerGo:false,
   blockers:[...new Set(blockers)]
 };
 return result;
}
