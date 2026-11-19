import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { withTenant, requireMembership, recordChange } from './database.mjs';
import { hashPassword, verifyPassword, sha256 } from './password.mjs';
import { registerStaffRoutes } from './staff.mjs';
import { registerScheduleRoutes, lockResource, assertBookable } from './schedule.mjs';
import { registerIntegrationRoutes } from './integrations.mjs';
import { registerGuestRoutes } from './guest.mjs';
import { probeGuestDatabase } from './readiness.mjs';
import {loadTenantPermit,assertTenantPermission} from './guest-tenant-authorization.mjs';
import {r16Configured,loadR16Registry,assertR16Tenant,inspectR16Tenant} from './guest-r16-registry.mjs';
import {r17Configured,loadR17Witness} from './guest-r17-witness.mjs';
import {assertR17Fence,inspectR17Fence} from './guest-r17-fence.mjs';
import {r18Configured,loadR18Anchor} from './guest-r18-anchor.mjs';
import {assertR18Fence,inspectR18Fence} from './guest-r18-fence.mjs';
import {r19Configured,collectionOperation,loadR19Scope,inspectR19Scope} from './guest-r19-scope.mjs';
import {assertR19Pilot,consumeR19Budget} from './guest-r19-usage.mjs';

const PREFIX='/api/industry/v1';
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isoPattern=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const rolesWrite=['owner','manager','operator'];
const rolesManage=['owner','manager'];
const permittedStatus={new:['confirmed','cancelled'],confirmed:['done','cancelled'],done:[],cancelled:[]};

function httpError(code,message){const e=new Error(message);e.statusCode=code;return e;}
function text(v,min=1,max=120){
  if(typeof v!=='string') throw httpError(400,'Ожидается строка');
  const trimmed=v.trim();
  if(trimmed.length<min||trimmed.length>max) throw httpError(400,'Некорректная длина строки');
  return trimmed;
}
function identifier(value){
  if(typeof value!=='string'||!uuidPattern.test(value)) throw httpError(400,'Некорректный идентификатор');
  return value;
}
function whole(value,min=0,max=100000000){
  if(!Number.isSafeInteger(value)||value<min||value>max) throw httpError(400,'Некорректное число');
  return value;
}
function bodyOf(request){
  if(!request.body||typeof request.body!=='object'||Array.isArray(request.body)) throw httpError(400,'Некорректное тело запроса');
  return request.body;
}
function equalHash(a,b){
  if(!/^[a-f0-9]{64}$/.test(String(a))||!/^[a-f0-9]{64}$/.test(String(b)))return false;
  return timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
}
function config(){
  const secure=process.env.NODE_ENV==='production';
  if(secure && process.env.ALLOWED_ORIGIN!=='https://osmanx.world')
    throw Error('ALLOWED_ORIGIN must be https://osmanx.world in production');
  return {secure,origin:process.env.ALLOWED_ORIGIN||'http://localhost',sid:secure?'__Host-osmanx_industry_sid':'osmanx_industry_sid',csrf:secure?'__Host-osmanx_industry_csrf':'osmanx_industry_csrf'};
}
export async function buildApp(pool){
  const opt=config();
  const app=Fastify({logger:false,bodyLimit:32768,trustProxy:false});
  await app.register(cookie);
  const dummyHash=await hashPassword('!InvalidAccountPassword-v3!');

  app.addHook('onRequest',async(req,reply)=>{
    reply.header('Cache-Control','no-store');
    reply.header('X-Content-Type-Options','nosniff');
    reply.header('Referrer-Policy','no-referrer');
    const origin=req.headers.origin;
    if(origin && origin!==opt.origin && ['POST','PATCH','PUT','DELETE'].includes(req.method))
      throw httpError(403,'Недопустимое происхождение запроса');
    // R6: a healthy container is NOT authorization to collect real pilot data.
    // Production writes remain fail-closed until an operator enables them after staging.
    const guestMutation=opt.secure &&
      ['POST','PATCH','PUT','DELETE'].includes(req.method) &&
      (req.url===PREFIX+'/guest' || req.url.startsWith(PREFIX+'/guest/'));
    if(guestMutation){
      if(process.env.GUEST_WRITES_ENABLED!=='true')
        throw httpError(503,'Сбор данных пилотов отключён до приёмки инфраструктуры');
      // R10: even an operator enabling writes cannot bypass migration/RLS/least-privilege checks.
      // Fail closed before parsing or mutating any protected Guest records.
      await probeGuestDatabase(pool);
      // R15: fail closed before authentication or any mutation if the external
      // signed admission packet is missing, expired, or mismatched to this release.
      // A valid packet alone never authorizes a request; authentication, CSRF,
      // tenant membership and existing R12/R13 safeguards still apply.
      try{
        // R16 opt-in never silently falls back to R15 if a signed registry is absent.
        if(r17Configured(process.env)&&!r16Configured(process.env))
          throw Error('R17 requires R16');
        if(r18Configured(process.env)&&!r17Configured(process.env))
          throw Error('R18 requires R17');
        if(r19Configured(process.env)&&!r18Configured(process.env)&&
           collectionOperation(req.url,req.method))
          throw Error('R19 scoped collection requires R18');
        if(r16Configured(process.env))req.guestRegistry=await loadR16Registry(process.env);
        else req.guestAdmission=await loadTenantPermit(process.env);
        if(r17Configured(process.env)){
          req.r17Witness=await loadR17Witness(process.env);
          if(req.guestRegistry.digest!==req.r17Witness.registryDigest)
            throw Error('Registry changed during admission');
        }
        if(r18Configured(process.env))
          req.r18Anchor=await loadR18Anchor(process.env,req.r17Witness);
        if(r19Configured(process.env)&&collectionOperation(req.url,req.method))
          req.r19Scope=await loadR19Scope(process.env,req.r18Anchor);
      }catch{
        throw httpError(503,'Нужен актуальный подписанный допуск компании R15/R16');
      }
    }
  });
  app.setErrorHandler((error,req,reply)=>{
    const dbCode=error.code;
    let status=error.statusCode&&Number.isInteger(error.statusCode)?error.statusCode:500;
    let message=status<500?error.message:'Внутренняя ошибка';
    if(dbCode==='23P01'||dbCode==='23505'){status=409;message='Конфликт данных или времени записи';}
    if(dbCode==='23503'||dbCode==='23514'||dbCode==='22P02'){status=400;message='Недопустимые связанные данные';}
    if(dbCode==='42501'){status=403;message='Операция запрещена';}
    if(status>=500) console.error('Industry API:',error.code||'',error.message);
    reply.code(status).send({error:message});
  });
  async function auth(request){
    const raw=request.cookies?.[opt.sid];
    if(typeof raw!=='string'||raw.length<32||raw.length>128)throw httpError(401,'Требуется вход');
    const r=await pool.query(
      'SELECT s.account_id,s.tenant_id,s.csrf_hash,a.email FROM industry.sessions s JOIN industry.accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT a.disabled',
      [sha256(raw)]
    );
    if(!r.rowCount)throw httpError(401,'Сессия отсутствует или истекла');
    const session=r.rows[0];
    if(['POST','PATCH','PUT','DELETE'].includes(request.method)){
      const supplied=request.headers['x-csrf-token'];
      if(typeof supplied!=='string'||!equalHash(sha256(supplied),session.csrf_hash))throw httpError(403,'CSRF-токен отсутствует или неверен');
    }
    return session;
  }
  async function forTenant(request,roles,fn){
    const session=await auth(request);
    const guestMutation=opt.secure && ['POST','PATCH','PUT','DELETE'].includes(request.method) &&
      (request.url===PREFIX+'/guest'||request.url.startsWith(PREFIX+'/guest/'));
    let witness=null,externalAnchor=null,scopedPilot=null;
    const collection=guestMutation&&r19Configured(process.env)?
      collectionOperation(request.url,request.method):null;
    if(guestMutation){
      if(r16Configured(process.env)){
        // Tenant always comes from the authenticated session, not a request body.
        await assertR16Tenant(session.tenant_id,process.env);
        if(r17Configured(process.env)){
          try{
            witness=await loadR17Witness(process.env);
            if(witness.registryDigest!==request.guestRegistry?.digest||
               witness.checkpointDigest!==request.r17Witness?.checkpointDigest)
              throw Error('Checkpoint changed during authorization');
          }catch{throw httpError(503,'R17: независимое подтверждение не прошло');}
          if(r18Configured(process.env)){
            try{
              externalAnchor=await loadR18Anchor(process.env,witness);
              if(externalAnchor.anchorDigest!==request.r18Anchor?.anchorDigest||
                 externalAnchor.checkpointDigest!==witness.checkpointDigest)
                throw Error('External anchor changed during authorization');
            }catch{throw httpError(503,'R18: внешний контрольный якорь не подтверждён');}
          }
          if(collection){
            try{
              scopedPilot=await loadR19Scope(process.env,externalAnchor);
              if(scopedPilot.scopeDigest!==request.r19Scope?.scopeDigest||
                 scopedPilot.tenantId!==session.tenant_id||
                 scopedPilot.pilotId!==collection.pilotId)
                throw Error('R19 tenant or pilot changed since request start');
            }catch{throw httpError(503,'R19: сбор для этого пилота не разрешён');}
          }
        }
      }else assertTenantPermission(request.guestAdmission,session.tenant_id);
    }
    return withTenant(pool,session.tenant_id,async db=>{
      const role=await requireMembership(db,session.tenant_id,session.account_id,roles);
      // The fence advances inside this exact transaction, not before it.
      if(witness)await assertR17Fence(db,witness);
      if(externalAnchor)await assertR18Fence(db,externalAnchor);
      if(scopedPilot)await assertR19Pilot(db,session.tenant_id,collection.pilotId,scopedPilot);
      const response=await fn(db,session,role);
      if(witness){
        // Late stop/revocation/checkpoint change aborts the entire transaction.
        await assertR16Tenant(session.tenant_id,process.env);
        let latest;
        try{latest=await loadR17Witness(process.env);}
        catch{throw httpError(503,'R17: подтверждение изменилось во время операции');}
        if(latest.checkpointDigest!==witness.checkpointDigest)
          throw httpError(503,'R17: требуется повторить операцию после обновления допуска');
        await assertR17Fence(db,latest);
        if(externalAnchor){
          let latestAnchor;
          try{latestAnchor=await loadR18Anchor(process.env,latest);}
          catch{throw httpError(503,'R18: внешний контрольный якорь изменился');}
          if(latestAnchor.anchorDigest!==externalAnchor.anchorDigest)
            throw httpError(503,'R18: повторите операцию с новым подтверждением');
          await assertR18Fence(db,latestAnchor);
        }
      }
      if(scopedPilot){
        // STOP and scope changes invalidate the *whole* SQL transaction.
        let latest;
        try{latest=await loadR19Scope(process.env,externalAnchor);}
        catch{throw httpError(503,'R19: допуск отменён во время операции');}
        if(latest.scopeDigest!==scopedPilot.scopeDigest)
          throw httpError(503,'R19: требуется новый допуск пилота');
        await assertR19Pilot(db,session.tenant_id,collection.pilotId,latest);
        if(response?.duplicate!==true)
          await consumeR19Budget(db,{
            tenantId:session.tenant_id,pilotId:collection.pilotId,
            kind:collection.kind,scope:latest
          });
      }
      return response;
    });
  }
  function setCookies(reply,token,csrf){
    const common={path:'/',secure:opt.secure,sameSite:'strict',maxAge:8*3600};
    reply.setCookie(opt.sid,token,{...common,httpOnly:true});
    reply.setCookie(opt.csrf,csrf,{...common,httpOnly:false});
  }
  function clearCookies(reply){
    reply.clearCookie(opt.sid,{path:'/',secure:opt.secure,sameSite:'strict'});
    reply.clearCookie(opt.csrf,{path:'/',secure:opt.secure,sameSite:'strict'});
  }
  app.get(PREFIX+'/guest/admission/self',async req=>forTenant(req,rolesManage,async(db,session)=>{
    // Company-scoped, read-only status. Never return key paths, manifests,
    // other companies, operational secrets or approval documents.
    if(!opt.secure||process.env.GUEST_WRITES_ENABLED!=='true')
      return {schema:'osmanx.guest.r16.self-status.v1',
        mode:'disabled',permitValid:false,reason:'guest_writes_disabled',writesChanged:false};
    if(r16Configured(process.env)){
      const status=await inspectR16Tenant(session.tenant_id,process.env);
      let witnessVerified=null,witnessSequence=null,witnessFenceReady=null;
      let externalAnchorVerified=null,externalAnchorFenceReady=null,externalAnchorSequence=null;
      if(r17Configured(process.env)){
        witnessVerified=false;witnessFenceReady=false;
        try{
          const witness=await loadR17Witness(process.env);
          const fence=await inspectR17Fence(db,witness);
          witnessVerified=true;witnessSequence=witness.sequence;
          witnessFenceReady=fence.fenceReady;
          if(r18Configured(process.env)){
            externalAnchorVerified=false;externalAnchorFenceReady=false;
            const anchor=await loadR18Anchor(process.env,witness);
            const anchorFence=await inspectR18Fence(db,anchor);
            externalAnchorVerified=true;externalAnchorSequence=anchor.sequence;
            externalAnchorFenceReady=anchorFence.fenceReady;
          }
        }catch{/* No filenames or private documents in the status response. */}
      }
      if(r18Configured(process.env)&&externalAnchorVerified===null){
        externalAnchorVerified=false;externalAnchorFenceReady=false;
      }
      const pilotCollection=r19Configured(process.env)?
        await inspectR19Scope(session.tenant_id,process.env):null;
      const allowed=status.permitValid&&witnessVerified!==false&&witnessFenceReady!==false&&
        externalAnchorVerified!==false&&externalAnchorFenceReady!==false;
      return {schema:'osmanx.guest.r16.self-status.v1',mode:'multi',
        permitValid:allowed,
        reason:status.permitValid&&!allowed?
          (externalAnchorVerified===false||externalAnchorFenceReady===false?
            'r18_anchor_or_fence_unavailable':'r17_witness_or_fence_unavailable'):status.reason,
        registryRevision:status.registryRevision,validUntil:status.validUntil,
        witnessVerified,witnessSequence,witnessFenceReady,
        externalAnchorVerified,externalAnchorFenceReady,externalAnchorSequence,
        pilotCollection,writesChanged:false};
    }
    try{
      const bundle=await loadTenantPermit(process.env);
      assertTenantPermission(bundle,session.tenant_id);
      return {schema:'osmanx.guest.r16.self-status.v1',mode:'single',
        permitValid:true,reason:'authorized',validUntil:bundle.permit.expiresAt,
        writesChanged:false};
    }catch{
      return {schema:'osmanx.guest.r16.self-status.v1',mode:'single',
        permitValid:false,reason:'invalid_or_missing_permit',writesChanged:false};
    }
  }));
  app.get(PREFIX+'/health/live',async()=>({status:'live'}));
  app.get(PREFIX+'/health/ready',async()=>{
    const integrity=await probeGuestDatabase(pool);
    return {status:'ready',database:'ok',...integrity,
      guestWritesEnabled:!opt.secure||process.env.GUEST_WRITES_ENABLED==='true'};
  });

  app.post(PREFIX+'/auth/login',async(req,reply)=>{
    const b=bodyOf(req);
    const email=text(b.email,5,254).toLowerCase();
    const password=text(b.password,1,200);
    const slug=text(b.tenantSlug,2,64).toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug))throw httpError(400,'Проверьте email и компанию');
    const ipKey=sha256(req.ip);
    const lock=await pool.query('SELECT failures,locked_until FROM industry.login_attempts WHERE email=$1 AND ip_hash=$2',[email,ipKey]);
    if(lock.rows[0]?.locked_until&&new Date(lock.rows[0].locked_until)>new Date())throw httpError(429,'Слишком много попыток. Повторите позже');
    const account=(await pool.query('SELECT id,password_hash FROM industry.accounts WHERE email=$1 AND NOT disabled',[email])).rows[0];
    const tenant=(await pool.query('SELECT industry.find_tenant($1) AS id',[slug])).rows[0]?.id;
    const valid=await verifyPassword(password,account?.password_hash||dummyHash);
    let member=false;
    if(valid && tenant && account){
      member=await withTenant(pool,tenant,async db=>(await db.query('SELECT role FROM industry.memberships WHERE tenant_id=$1 AND account_id=$2',[tenant,account.id])).rowCount>0);
    }
    if(!valid||!member){
      await pool.query(
        "INSERT INTO industry.login_attempts(email,ip_hash,failures,locked_until) VALUES($1,$2,1,NULL) ON CONFLICT(email,ip_hash) DO UPDATE SET failures=CASE WHEN industry.login_attempts.updated_at < now()-interval '15 minutes' THEN 1 ELSE industry.login_attempts.failures+1 END, locked_until=CASE WHEN industry.login_attempts.updated_at >= now()-interval '15 minutes' AND industry.login_attempts.failures>=4 THEN now()+interval '15 minutes' ELSE NULL END,updated_at=now()",
        [email,ipKey]);
      throw httpError(401,'Неверная компания, email или пароль');
    }
    await pool.query('DELETE FROM industry.login_attempts WHERE email=$1 AND ip_hash=$2',[email,ipKey]);
    const token=randomBytes(32).toString('base64url');
    const csrf=randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO industry.sessions(token_hash,account_id,tenant_id,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '8 hours')",[sha256(token),account.id,tenant,sha256(csrf)]);
    setCookies(reply,token,csrf);
    return {authenticated:true};
  });

  app.get(PREFIX+'/auth/me',async req=>forTenant(req,null,async(db,session,role)=>{
    const r=await db.query('SELECT id,name,slug,vertical FROM industry.tenants WHERE id=$1',[session.tenant_id]);
    return {account:{id:session.account_id,email:session.email},tenant:r.rows[0],role};
  }));
  app.post(PREFIX+'/auth/logout',async(req,reply)=>{
    const session=await auth(req);
    await pool.query('DELETE FROM industry.sessions WHERE token_hash=$1',[sha256(req.cookies[opt.sid])]);
    clearCookies(reply);
    return {loggedOut:true};
  });

  app.get(PREFIX+'/dashboard',async req=>forTenant(req,null,async(db,s)=>{
    const r=await db.query(
      "SELECT (SELECT count(*)::int FROM industry.customers WHERE tenant_id=$1) AS customers, (SELECT count(*)::int FROM industry.services WHERE tenant_id=$1 AND active) AS services, (SELECT count(*)::int FROM industry.appointments WHERE tenant_id=$1 AND status IN ('new','confirmed')) AS active_appointments, (SELECT count(*)::int FROM industry.appointments WHERE tenant_id=$1 AND status='done') AS completed_appointments",
      [s.tenant_id]);
    return {stats:r.rows[0]};
  }));
  app.get(PREFIX+'/resources',async req=>forTenant(req,null,async(db,s)=>{
    const r=await db.query('SELECT id,name,active FROM industry.resources WHERE tenant_id=$1 ORDER BY created_at ASC LIMIT 200',[s.tenant_id]);
    return {items:r.rows};
  }));
  app.post(PREFIX+'/resources',async(req,reply)=>forTenant(req,rolesManage,async(db,s)=>{
    const name=text(bodyOf(req).name,2,100);
    const r=await db.query('INSERT INTO industry.resources(tenant_id,name) VALUES($1,$2) RETURNING id,name,active',[s.tenant_id,name]);
    await db.query("INSERT INTO industry.resource_hours(tenant_id,resource_id,weekday,opens_at,closes_at) SELECT $1,$2,w,'09:00'::time,'18:00'::time FROM generate_series(1,6) AS w",[s.tenant_id,r.rows[0].id]);
    await recordChange(db,s.tenant_id,s.account_id,'resource.created',r.rows[0].id);
    reply.code(201);return {item:r.rows[0]};
  }));

  app.get(PREFIX+'/customers',async req=>forTenant(req,null,async(db,s)=>{
    const r=await db.query('SELECT id,display_name,phone,email,created_at FROM industry.customers WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200',[s.tenant_id]);
    return {items:r.rows};
  }));
  app.post(PREFIX+'/customers',async(req,reply)=>forTenant(req,rolesWrite,async(db,s)=>{
    const b=bodyOf(req),name=text(b.displayName,2,120);
    const phone=b.phone?text(b.phone,3,32):null;
    const email=b.email?text(b.email,5,254).toLowerCase():null;
    if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw httpError(400,'Недопустимый email');
    const r=await db.query('INSERT INTO industry.customers(tenant_id,display_name,phone,email) VALUES($1,$2,$3,$4) RETURNING id,display_name,phone,email,created_at',[s.tenant_id,name,phone,email]);
    await recordChange(db,s.tenant_id,s.account_id,'customer.created',r.rows[0].id);
    reply.code(201);return {item:r.rows[0]};
  }));
  app.get(PREFIX+'/services',async req=>forTenant(req,null,async(db,s)=>{
    const r=await db.query('SELECT id,name,duration_minutes,price_minor,active FROM industry.services WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200',[s.tenant_id]);
    return {items:r.rows};
  }));
  app.post(PREFIX+'/services',async(req,reply)=>forTenant(req,rolesManage,async(db,s)=>{
    const b=bodyOf(req),name=text(b.name,2,120),duration=whole(b.durationMinutes,5,480),price=whole(b.priceMinor,0,10000000000);
    const r=await db.query('INSERT INTO industry.services(tenant_id,name,duration_minutes,price_minor) VALUES($1,$2,$3,$4) RETURNING id,name,duration_minutes,price_minor,active',[s.tenant_id,name,duration,price]);
    await recordChange(db,s.tenant_id,s.account_id,'service.created',r.rows[0].id);
    reply.code(201);return {item:r.rows[0]};
  }));
  app.get(PREFIX+'/appointments',async req=>forTenant(req,null,async(db,s)=>{
    const r=await db.query(
      'SELECT a.id,a.customer_id,a.service_id,a.resource_id,a.starts_at,a.ends_at,a.status,c.display_name AS customer_name,v.name AS service_name,r.name AS resource_name FROM industry.appointments a JOIN industry.customers c ON c.tenant_id=a.tenant_id AND c.id=a.customer_id JOIN industry.services v ON v.tenant_id=a.tenant_id AND v.id=a.service_id JOIN industry.resources r ON r.tenant_id=a.tenant_id AND r.id=a.resource_id WHERE a.tenant_id=$1 ORDER BY a.starts_at DESC LIMIT 200',[s.tenant_id]);
    return {items:r.rows};
  }));
  app.post(PREFIX+'/appointments',async(req,reply)=>forTenant(req,rolesWrite,async(db,s)=>{
    const b=bodyOf(req),customer=identifier(b.customerId),service=identifier(b.serviceId),resource=identifier(b.resourceId);
    if(typeof b.startsAt!=='string'||!isoPattern.test(b.startsAt))throw httpError(400,'Укажите дату с часовым поясом');
    const start=new Date(b.startsAt),now=Date.now();
    if(!Number.isFinite(start.getTime())||start.getTime()<now-60*60*1000||start.getTime()>now+370*24*3600*1000)throw httpError(400,'Запись должна быть в ближайшие 370 дней');
    const key=req.headers['idempotency-key'];
    if(key!==undefined && (typeof key!=='string'||!/^[a-zA-Z0-9._:-]{8,80}$/.test(key)))throw httpError(400,'Некорректный ключ повторного запроса');
    const fingerprint=sha256(JSON.stringify([customer,service,resource,start.toISOString()]));
    if(key){
      const prev=await db.query('SELECT id,starts_at,status,idempotency_fingerprint FROM industry.appointments WHERE tenant_id=$1 AND idempotency_key=$2',[s.tenant_id,key]);
      if(prev.rowCount){
        if(prev.rows[0].idempotency_fingerprint!==fingerprint)throw httpError(409,'Ключ уже использован для другой записи');
        const {id,starts_at,status}=prev.rows[0];
        return {item:{id,starts_at,status},duplicate:true};
      }
    }
    const duration=(await db.query('SELECT duration_minutes FROM industry.services WHERE tenant_id=$1 AND id=$2 AND active',[s.tenant_id,service])).rows[0]?.duration_minutes;
    if(!duration)throw httpError(404,'Услуга недоступна');
    await lockResource(db,s.tenant_id,resource);
    const endsAt=new Date(start.getTime()+duration*60000).toISOString();
    await assertBookable(db,s.tenant_id,resource,start.toISOString(),endsAt);
    const r=await db.query(
      "INSERT INTO industry.appointments(tenant_id,customer_id,service_id,resource_id,starts_at,ends_at,idempotency_key,idempotency_fingerprint) VALUES($1,$2,$3,$4,$5::timestamptz,$5::timestamptz + make_interval(mins => $6::int),$7,$8) RETURNING id,starts_at,ends_at,status",
      [s.tenant_id,customer,service,resource,start.toISOString(),duration,key||null,key?fingerprint:null]);
    await recordChange(db,s.tenant_id,s.account_id,'appointment.created',r.rows[0].id,{status:'new'});
    reply.code(201);return {item:r.rows[0]};
  }));
  app.patch(PREFIX+'/appointments/:id/status',async(req)=>forTenant(req,rolesWrite,async(db,s)=>{
    const bookingId=identifier(req.params.id),status=text(bodyOf(req).status,3,12);
    const existing=await db.query('SELECT status FROM industry.appointments WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenant_id,bookingId]);
    if(!existing.rowCount)throw httpError(404,'Запись не найдена');
    if(!permittedStatus[existing.rows[0].status]?.includes(status))throw httpError(409,'Переход статуса запрещён');
    const r=await db.query('UPDATE industry.appointments SET status=$1,updated_at=now() WHERE tenant_id=$2 AND id=$3 RETURNING id,status,updated_at',[status,s.tenant_id,bookingId]);
    await recordChange(db,s.tenant_id,s.account_id,'appointment.status_changed',bookingId,{status});
    return {item:r.rows[0]};
  }));
  app.get(PREFIX+'/audit',async(req)=>forTenant(req,rolesManage,async(db,s)=>{
    const r=await db.query('SELECT actor_id,action,target_id,occurred_at FROM industry.audit_events WHERE tenant_id=$1 ORDER BY occurred_at DESC LIMIT 100',[s.tenant_id]);
    return {items:r.rows};
  }));
  registerStaffRoutes(app,{prefix:PREFIX,pool,forTenant,bodyOf});
  registerScheduleRoutes(app,{prefix:PREFIX,forTenant,bodyOf,identifier});
  registerIntegrationRoutes(app,{prefix:PREFIX,forTenant});
  registerGuestRoutes(app,{prefix:PREFIX,forTenant,bodyOf});
  return app;
}
