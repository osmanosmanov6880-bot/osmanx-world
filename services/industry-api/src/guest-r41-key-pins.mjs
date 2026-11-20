/**
 * R41 out-of-band Ed25519 trust-anchor pinning. A correctly signed message
 * must NOT become operator GO if its public key was replaced with an
 * attacker-controlled key. Pins come from a separate trusted operator channel.
 */
import {createHash,createPublicKey,timingSafeEqual} from 'node:crypto';
export const R41_KEY_PIN_SCHEMA='osmanx.guest.r41.ed25519-trust-pins.v1';
const HEX=/^[a-f0-9]{64}$/;
export function r41PublicKeyFingerprint(pem){
  const key=createPublicKey(pem);
  if(key.asymmetricKeyType!=='ed25519')
    throw Error('R41 expects Ed25519 SPKI public keys');
  return createHash('sha256').update(
    key.export({type:'spki',format:'der'})
  ).digest('hex');
}
export function verifyR41KeyPins({owner,manager,ownerPin,managerPin}={}){
  const failures=[];
  if(!HEX.test(ownerPin||'')||!HEX.test(managerPin||''))
    failures.push('MISSING_TRUSTED_OUT_OF_BAND_KEY_PINS');
  let realOwner,realManager;
  try{
    realOwner=r41PublicKeyFingerprint(owner);
    realManager=r41PublicKeyFingerprint(manager);
  }catch{
    failures.push('INVALID_ED25519_PUBLIC_KEYS');
  }
  if(realOwner&&realManager&&realOwner===realManager)
    failures.push('SAME_ACTOR_PUBLIC_KEY');
  if(HEX.test(ownerPin||'')&&HEX.test(managerPin||'')&&
    ownerPin===managerPin)
    failures.push('SAME_TRUST_PIN_FOR_BOTH_ROLES');
  if(realOwner&&HEX.test(ownerPin||'')&&
    !timingSafeEqual(Buffer.from(realOwner,'hex'),Buffer.from(ownerPin,'hex')))
    failures.push('OWNER_PUBLIC_KEY_NOT_TRUSTED');
  if(realManager&&HEX.test(managerPin||'')&&
    !timingSafeEqual(Buffer.from(realManager,'hex'),Buffer.from(managerPin,'hex')))
    failures.push('MANAGER_PUBLIC_KEY_NOT_TRUSTED');
  return {schema:R41_KEY_PIN_SCHEMA,valid:failures.length===0,
    blockers:[...new Set(failures)],
    fingerprintsReturned:false,privateKeysRead:false,
    operatorGo:false,productionWritesEnabled:false};
}
