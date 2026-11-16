import { scrypt as scryptCallback, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const COST = 32768, R = 8, P = 1;
export const sha256 = text => createHash('sha256').update(String(text)).digest('hex');
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) throw Error('Password must be 12-200 characters');
  const salt = randomBytes(24).toString('hex');
  const key = await scrypt(password, Buffer.from(salt,'hex'), 64, {N:COST,r:R,p:P,maxmem:64*1024*1024});
  return ['scrypt', COST, R, P, salt, key.toString('hex')].join('$');
}
export async function verifyPassword(password, stored) {
  const parts = String(stored||'').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || Number(parts[1]) !== COST || Number(parts[2]) !== R || Number(parts[3]) !== P) return false;
  if (!/^[a-f0-9]{48}$/.test(parts[4]) || !/^[a-f0-9]{128}$/.test(parts[5])) return false;
  const key = await scrypt(String(password), Buffer.from(parts[4],'hex'), 64,{N:COST,r:R,p:P,maxmem:64*1024*1024});
  return timingSafeEqual(Buffer.from(parts[5],'hex'),key);
}
