/**
 * R38 immutable no-GO operator evidence across local compose/DR/image and
 * GitHub human-review signals. No external action is inferred from hashes.
 */
import {createHash} from 'node:crypto';
export const R38_EVIDENCE_SCHEMA='osmanx.guest.r38.operator-evidence.v1';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function evaluateR38Evidence({compose,dr,image,review}={}){
  const blockers=[];
  if(compose?.schema!=='osmanx.guest.r38.rendered-compose.v1'||
    compose.valid!==true||compose.productionAuthorized!==false)
    blockers.push('RENDERED_COMPOSE_MISSING');
  if(dr?.schema!=='osmanx.guest.r38.local-restore-proof.v1'||
    dr.localDbVerified!==true||dr.realOffsiteWitness!==false||
    dr.productionAuthorized!==false)
    blockers.push('LOCAL_DR_EVIDENCE_MISSING');
  if(image?.localMetadataConsistent!==true||
    image.remoteVpsDeploymentVerified!==false||
    image.productionAuthorized!==false)
    blockers.push('IMAGE_PARITY_MISSING');
  if(review?.schema!=='osmanx.guest.r38.first-review-policy.v1'||
    review.reviewSignalComplete!==true||
    review.mergePermissionGranted!==false)
    blockers.push('CURRENT_PR_REVIEW_MISSING');
  const body={schema:R38_EVIDENCE_SCHEMA,
    localEvidenceReadyForIndependentHumanReview:blockers.length===0,
    blockers,
    independentOffsiteRecoveryVerified:false,
    remoteStagingVerified:false,legalAuthorityApproved:false,
    mergedMainCiVerified:false,customerGo:false,
    stopLifted:false,productionAuthorized:false};
  return {...body,sha256:sha(body)};
}
