/** Cloudflare Access JWT verification with JWKS. NEVER trust email/header until signature is checked. */
const jwksCache = new Map();
const encoder = new TextEncoder();
const b64url = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('Invalid base64url');
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4-value.length%4)%4));
  return Uint8Array.from(raw, x=>x.charCodeAt(0));
};
const decode = value => JSON.parse(new TextDecoder().decode(b64url(value)));
const emails = list => new Set(String(list||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));
function teamURL(env){
  const v=String(env.ACCESS_TEAM_DOMAIN||'').replace(/\/$/,'');
  if(!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/i.test(v)) throw Error('Access domain not configured');
  return v;
}
async function getKeys(domain, fetcher){
  let entry=jwksCache.get(domain);
  if(entry && entry.expires>Date.now()) return entry.keys;
  const res=await fetcher(domain+'/cdn-cgi/access/certs',{headers:{Accept:'application/json'}});
  if(!res.ok)throw Error('Access public keys unavailable');
  const parsed=await res.json();
  if(!Array.isArray(parsed.keys)||parsed.keys.length>20)throw Error('Invalid JWKS');
  const keys=parsed.keys.filter(k=>k.kty==='RSA'&&k.alg==='RS256'&&k.kid&&k.n&&k.e);
  if(!keys.length)throw Error('No signing keys');
  jwksCache.set(domain,{keys,expires:Date.now()+5*60_000});
  return keys;
}
export async function verifiedActor(request,env,fetcher=fetch){
  try{
    const domain=teamURL(env),aud=String(env.ACCESS_AUD||'');
    if(aud.length<10)throw Error('Missing Access audience');
    const jwt=request.headers.get('Cf-Access-Jwt-Assertion')||'';
    if(jwt.length<80||jwt.length>12000)throw Error('Missing Access JWT');
    const parts=jwt.split('.');if(parts.length!==3)throw Error('JWT malformed');
    const header=decode(parts[0]),payload=decode(parts[1]);
    if(header.alg!=='RS256'||typeof header.kid!=='string')throw Error('JWT algorithm rejected');
    const now=Math.floor(Date.now()/1000);
    if(payload.iss!==domain||!(Array.isArray(payload.aud)?payload.aud.includes(aud):payload.aud===aud)||
       !Number.isFinite(payload.exp)||payload.exp<=now||payload.exp>now+86400||
       (payload.nbf!==undefined && (!Number.isFinite(payload.nbf)||payload.nbf>now+60))||
       (payload.iat!==undefined && (!Number.isFinite(payload.iat)||payload.iat>now+60)))throw Error('JWT claims rejected');
    const key=(await getKeys(domain,fetcher)).find(k=>k.kid===header.kid);
    if(!key)throw Error('Unknown JWT key');
    const imported=await crypto.subtle.importKey('jwk',{kty:'RSA',n:key.n,e:key.e,alg:'RS256',ext:true,key_ops:['verify']},
      {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    if(!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',imported,b64url(parts[2]),encoder.encode(parts[0]+'.'+parts[1]))))throw Error('Invalid JWT signature');
    const email=String(payload.email||'').trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('Missing verified email');
    const role={editor:emails(env.EDITOR_EMAILS).has(email),approver:emails(env.APPROVER_EMAILS).has(email),moderator:emails(env.MODERATOR_EMAILS).has(email)};
    if(!Object.values(role).some(Boolean))throw Error('No operator role');
    return {email,...role};
  }catch{return null;}
}
export function adminWriteAllowed(request){return request.headers.get('Origin')==='https://osmanx.world'&&request.headers.get('Content-Type')?.startsWith('application/json');}
export function resetKeyCacheForTests(){jwksCache.clear();}
