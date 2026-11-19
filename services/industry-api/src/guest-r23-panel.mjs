/**
 * R23 operator panel is local READ ONLY evidence. External GitHub merge,
 * VPS HTTP, DR, human consent and WORM cannot be proved by the browser.
 * Never return privileged identifiers, credentials, report bodies or PII.
 */
export const PANEL_SCHEMA='osmanx.guest.r23.first-customer-handoff.v1';
const STEPS=Object.freeze([
  'review_r14_to_r22_ordered_pr_merges',
  'verify_final_main_ci_and_protected_branch',
  'inspect_real_vps_https_and_loopback',
  'run_two_tenant_rls_rehearsal',
  'verify_independent_offsite_age_dr',
  'verify_client_contract_consent_and_retention',
  'independent_change_window_signoff'
]);
export function inspectR23Panel({pilot,tenantId,hold,scope,r20,r21}={}){
  if(!pilot||typeof pilot.id!=='string'||!tenantId)
    throw new TypeError('R23 needs an authenticated scoped pilot');
  const checks={
    membershipScopedPilot:true,
    noEmergencyStop:hold?.active!==true,
    frozenProtocol:r20?.checks?.registeredProtocol===true,
    independentSignedPilot:scope?.valid===true&&
      scope?.tenantId===tenantId&&scope?.pilotId===pilot.id,
    r12LaunchEnrolled:r20?.checks?.launchEnrolled===true,
    r13ToR19Technical:r20?.technicalReviewPossible===true,
    securityMigrationsAndRls:r21?.checks?.allMigrationsPresent===true&&
      r21?.checks?.allSecurityTablesForcedRls===true,
    noElevatedRuntimeRole:r21?.checks?.runtimeRoleUnprivileged===true,
    immutableLedgerInSync:r21?.checks?.auditMatchesQuota===true,
    retentionNeedsNoAction:r21?.checks?.noOverRetentionDrift===true,
    orderedPrMergesVerified:false,
    realVpsCanaryVerified:false,
    twoTenantRlsWitnessVerified:false,
    independentOffsiteDrVerified:false,
    signedLegalDocumentsVerified:false,
    authorizedChangeWindowVerified:false
  };
  const pending=Object.entries(checks).filter(([,ok])=>ok!==true)
    .map(([name])=>name);
  const localChecks=[
    'membershipScopedPilot','noEmergencyStop','frozenProtocol',
    'independentSignedPilot','r12LaunchEnrolled','r13ToR19Technical',
    'securityMigrationsAndRls','noElevatedRuntimeRole',
    'immutableLedgerInSync','retentionNeedsNoAction'
  ];
  return {schema:PANEL_SCHEMA,pilotId:pilot.id,
    currentPhase:pilot.phase,
    checks,pending,operatorSequence:[...STEPS],
    localTechnicalPossible:localChecks.every(k=>checks[k]===true),
    evidenceCollectionComplete:false,
    onlyCurrentTenantReport:true,customerGo:false,
    legalGo:false,productionAuthorized:false,productionChanged:false,
    nextAction:'review_r14_to_r22_ordered_pr_merges'};
}
