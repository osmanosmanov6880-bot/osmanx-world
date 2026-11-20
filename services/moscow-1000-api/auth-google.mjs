/** Google OIDC server flow. Tokens and client secrets never enter browser JavaScript. */
import {verifiedActor} from './access.mjs';

const ROOT = '/moscow-1000/api/auth';
const FLOW_COOKIE = '__Host-osmanx-oauth';
const SESSION_COOKIE = '__Host-osmanx-admin';
const FLOW_TTL = 600;
const SESSION_TTL = 7200;
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let keyCache = null;
const now = () => Math.floor(Date.now() / 1000);
const baseHeaders = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const json = (data,status=200) => Response.json(data,{status,headers:baseHeaders});
const emails = value => new Set(String(value || '').split(',').map(x=>x.trim().toLowerCase()).filter(x=>/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(x)));
const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('Malformed encoding');
  return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4)),x=>x.charCodeAt(0));
}
const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
const hash = async value => encode(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))));
function originFor(env) {
  try {
    const value=String(env.SITE_ORIGIN || 'https://osmanx.world').replace(/\/$/,'');
    const url=new URL(value);
    return url.protocol==='https:' && !url.username && !url.password && url.origin===value ? value : null;
  } catch { return null; }
}
export function googleConfigured(env) {
  return Boolean(env.DB && originFor(env) && /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(String(env.GOOGLE_CLIENT_ID || '')) &&
    typeof env.GOOGLE_CLIENT_SECRET==='string' && env.GOOGLE_CLIENT_SECRET.length>=8 &&
    typeof env.AUTH_SESSION_SECRET==='string' && env.AUTH_SESSION_SECRET.length>=32 && emails(env.ADMIN_GOOGLE_EMAILS).size);
}
async function ready(env) {
  if (!googleConfigured(env)) return false;
  try {
    await env.DB.prepare('SELECT id FROM google_auth_flows LIMIT 1').first();
    await env.DB.prepare('SELECT id_hash FROM google_admin_sessions LIMIT 1').first();
    return true;
  } catch { return false; }
}
function readCookie(req,name) {
  const values=(req.headers.get('Cookie') || '').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));
  return values.length===1 ? values[0].slice(name.length+1) : null;
}
function cookie(name,value,maxAge) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
async function sign(payload,secret) {
  const text=encode(encoder.encode(JSON.stringify(payload)));
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return text+'.'+encode(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(text))));
}
async function unseal(value,secret,purpose,origin) {
  try {
    if (!secret || typeof value!=='string' || value.length>2000) return null;
    const parts=value.split('.');
    if (parts.length!==2) return null;
    const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    if (!await crypto.subtle.verify('HMAC',key,decode(parts[1]),encoder.encode(parts[0]))) return null;
    const payload=JSON.parse(decoder.decode(decode(parts[0])));
    return payload.purpose===purpose && payload.iss===origin && Number.isSafeInteger(payload.exp) && payload.exp>now() ? payload : null;
  } catch { return null; }
}
async function googleKeys(fetcher,force=false) {
  if (keyCache && keyCache.expires>Date.now() && (!force || Date.now()-keyCache.fetched<30000)) return keyCache.keys;
  const response=await fetcher(JWKS_URL,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw Error('Signing keys unavailable');
  const data=await response.json();
  if (!Array.isArray(data.keys) || data.keys.length>20) throw Error('Invalid key set');
  const keys=data.keys.filter(k=>k.kty==='RSA' && k.alg==='RS256' && (!k.use || k.use==='sig') && typeof k.kid==='string' && k.n && k.e);
  if (!keys.length) throw Error('Signing keys missing');
  keyCache={keys,fetched:Date.now(),expires:Date.now()+300000};
  return keys;
}
export async function verifyGoogleIdToken(token,env,nonce,fetcher=fetch) {
  if (typeof token!=='string' || token.length>16000 || token.length<80) throw Error('Missing identity token');
  const parts=token.split('.');
  if (parts.length!==3) throw Error('Malformed identity token');
  const header=JSON.parse(decoder.decode(decode(parts[0])));
  const payload=JSON.parse(decoder.decode(decode(parts[1])));
  const instant=now();
  const audiences=Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (header.alg!=='RS256' || typeof header.kid!=='string' || header.kid.length>200 ||
      !['https://accounts.google.com','accounts.google.com'].includes(payload.iss) || !audiences.includes(env.GOOGLE_CLIENT_ID) ||
      (audiences.length>1 && payload.azp!==env.GOOGLE_CLIENT_ID) || (payload.azp!==undefined && payload.azp!==env.GOOGLE_CLIENT_ID) ||
      !Number.isSafeInteger(payload.exp) || payload.exp<=instant || !Number.isSafeInteger(payload.iat) || payload.iat>instant+60 || payload.iat<instant-FLOW_TTL ||
      (payload.nbf!==undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf>instant+60)) ||
      typeof nonce!=='string' || nonce.length<32 || payload.nonce!==nonce || payload.email_verified!==true ||
      typeof payload.sub!=='string' || !/^[\x21-\x7e]{1,255}$/.test(payload.sub)) throw Error('Identity claims rejected');
  let key=(await googleKeys(fetcher)).find(k=>k.kid===header.kid);
  if (!key) key=(await googleKeys(fetcher,true)).find(k=>k.kid===header.kid);
  if (!key) throw Error('Unknown signing key');
  const imported=await crypto.subtle.importKey('jwk',{kty:'RSA',n:key.n,e:key.e,alg:'RS256',ext:true},{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',imported,decode(parts[2]),encoder.encode(parts[0]+'.'+parts[1]))) throw Error('Identity signature rejected');
  const email=typeof payload.email==='string' ? payload.email.trim().toLowerCase() : '';
  if (!emails(env.ADMIN_GOOGLE_EMAILS).has(email)) throw Error('Administrator not allowed');
  // For external addresses Google may only attest historical email ownership.
  // Email-based admin authorization therefore supports Gmail or Google Workspace.
  const hostedDomain=typeof payload.hd==='string' && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,63}$/i.test(payload.hd);
  if (!email.endsWith('@gmail.com') && !hostedDomain) throw Error('Authoritative Google email required');
  return {email,sub:payload.sub};
}
export async function verifiedGoogleActor(req,env) {
  if (!googleConfigured(env) || new URL(req.url).origin!==originFor(env)) return null;
  const payload=await unseal(readCookie(req,SESSION_COOKIE),env.AUTH_SESSION_SECRET,'session',originFor(env));
  if (!payload || !/^[A-Za-z0-9_-]{43}$/.test(payload.sid || '')) return null;
  try {
    const row=await env.DB.prepare('SELECT google_sub,email,expires_at FROM google_admin_sessions WHERE id_hash=?').bind(await hash(payload.sid)).first();
    if (!row || row.expires_at<=now() || row.expires_at!==payload.exp || !emails(env.ADMIN_GOOGLE_EMAILS).has(row.email)) return null;
    return {email:row.email,editor:true,approver:true,moderator:true,provider:'google',subject:row.google_sub};
  } catch { return null; }
}
export async function operatorActor(req,env,fetcher=fetch) {
  return await verifiedActor(req,env,fetcher) || await verifiedGoogleActor(req,env);
}
function redirect(location,cookies=[]) {
  const headers=new Headers({...baseHeaders,Location:location});
  for (const value of cookies) headers.append('Set-Cookie',value);
  return new Response(null,{status:303,headers});
}
export async function googleAuthRoute(req,env,fetcher=fetch) {
  const url=new URL(req.url),path=url.pathname;
  if (url.origin!==originFor(env)) return json({ok:false,error:'Unknown host'},404);
  if (path===ROOT+'/config' && req.method==='GET') {
    const configured=await ready(env);
    return json({ok:true,configured,googleEnabled:configured});
  }
  if (path===ROOT+'/session' && req.method==='GET') {
    const actor=await operatorActor(req,env,fetcher);
    return json(actor ? {ok:true,authenticated:true,actor:{email:actor.email,editor:actor.editor,approver:actor.approver,moderator:actor.moderator,provider:actor.provider || 'access'}} : {ok:true,authenticated:false});
  }
  if (path===ROOT+'/logout' && req.method==='POST') {
    if (req.headers.get('Origin')!==url.origin || !req.headers.get('Content-Type')?.startsWith('application/json')) return json({ok:false,error:'Неверный Origin или Content-Type.'},403);
    const payload=await unseal(readCookie(req,SESSION_COOKIE),env.AUTH_SESSION_SECRET,'session',url.origin);
    if (payload?.sid && env.DB) await env.DB.prepare('DELETE FROM google_admin_sessions WHERE id_hash=?').bind(await hash(payload.sid)).run();
    const response=json({ok:true,authenticated:false});
    response.headers.append('Set-Cookie',cookie(SESSION_COOKIE,'',0));
    response.headers.append('Set-Cookie',cookie(FLOW_COOKIE,'',0));
    return response;
  }
  if (!['/google/start','/google/callback'].some(p=>path===ROOT+p) || req.method!=='GET') return json({ok:false,error:'Route not found'},404);
  if (!await ready(env)) return json({ok:false,error:'Вход через Google ещё не подключён. Требуются настройки владельца.'},503);
  if (path===ROOT+'/google/start') {
    const id=random(),state=random(),browser=random(),nonce=random(),verifier=random(),expiry=now()+FLOW_TTL;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM google_auth_flows WHERE expires_at<=?').bind(now()),
      env.DB.prepare('INSERT INTO google_auth_flows(id,state_hash,browser_hash,nonce,verifier,expires_at) VALUES(?,?,?,?,?,?)').bind(id,await hash(state),await hash(browser),nonce,verifier,expiry)
    ]);
    const target=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const [key,value] of Object.entries({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:url.origin+ROOT+'/google/callback',response_type:'code',scope:'openid email',state,nonce,code_challenge:await hash(verifier),code_challenge_method:'S256',prompt:'select_account'})) target.searchParams.set(key,value);
    const sealed=await sign({purpose:'flow',iss:url.origin,id,browser,exp:expiry},env.AUTH_SESSION_SECRET);
    return redirect(target.href,[cookie(FLOW_COOKIE,sealed,FLOW_TTL)]);
  }
  const fail=code=>redirect('/moscow-1000/admin/?auth_error='+code,[cookie(FLOW_COOKIE,'',0)]);
  const payload=await unseal(readCookie(req,FLOW_COOKIE),env.AUTH_SESSION_SECRET,'flow',url.origin);
  const state=url.searchParams.get('state'),code=url.searchParams.get('code');
  if (!payload || !/^[A-Za-z0-9_-]{43}$/.test(state || '') || typeof code!=='string' || code.length<4 || code.length>4096 || url.searchParams.has('error')) return fail('expired');
  const row=await env.DB.prepare('SELECT * FROM google_auth_flows WHERE id=?').bind(payload.id).first();
  if (!row || row.consumed_at || row.expires_at<=now() || row.state_hash!==await hash(state) || row.browser_hash!==await hash(payload.browser || '')) return fail('expired');
  // Atomic one-time consumption stops parallel callbacks and replayed authorization codes.
  const consumed=await env.DB.prepare('UPDATE google_auth_flows SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?').bind(now(),row.id,now()).run();
  if (!consumed.meta?.changes) return fail('expired');
  try {
    const response=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,code,code_verifier:row.verifier,redirect_uri:url.origin+ROOT+'/google/callback',grant_type:'authorization_code'})});
    if (!response.ok) return fail('failed');
    const tokens=await response.json();
    const identity=await verifyGoogleIdToken(tokens.id_token,env,row.nonce,fetcher);
    const sid=random(),expiry=now()+SESSION_TTL;
    const old=await unseal(readCookie(req,SESSION_COOKIE),env.AUTH_SESSION_SECRET,'session',url.origin);
    const writes=[env.DB.prepare('DELETE FROM google_admin_sessions WHERE expires_at<=?').bind(now())];
    if (old?.sid) writes.push(env.DB.prepare('DELETE FROM google_admin_sessions WHERE id_hash=?').bind(await hash(old.sid)));
    writes.push(env.DB.prepare('INSERT INTO google_admin_sessions(id_hash,google_sub,email,created_at,expires_at) VALUES(?,?,?,?,?)').bind(await hash(sid),identity.sub,identity.email,now(),expiry));
    writes.push(env.DB.prepare('DELETE FROM google_auth_flows WHERE id=?').bind(row.id));
    await env.DB.batch(writes);
    const sealed=await sign({purpose:'session',iss:url.origin,sid,exp:expiry},env.AUTH_SESSION_SECRET);
    return redirect('/moscow-1000/admin/',[cookie(FLOW_COOKIE,'',0),cookie(SESSION_COOKIE,sealed,SESSION_TTL)]);
  } catch { return fail('failed'); }
}
export async function cleanupGoogleAuth(env) {
  if (!env.DB) return;
  await env.DB.batch([env.DB.prepare('DELETE FROM google_auth_flows WHERE expires_at<=?').bind(now()),env.DB.prepare('DELETE FROM google_admin_sessions WHERE expires_at<=?').bind(now())]);
}
export function resetGoogleKeyCacheForTests() { keyCache=null; }
