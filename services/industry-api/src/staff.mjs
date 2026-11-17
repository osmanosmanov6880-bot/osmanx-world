// R4 / staff: one-time invitations, tenant roles and account access revocation.
import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword, sha256 } from './password.mjs';
import { withTenant, recordChange } from './database.mjs';

const ROLES=['manager','operator','viewer'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const inviteToken=/^[a-f0-9]{64}$/;
function err(code,message){ const e=new Error(message);e.statusCode=code;return e;}
const parseId=id=>{if(typeof id!=='string'||!UUID.test(id))throw err(400,'Некорректный ID');return id;};
const emailOf=value=>{if(typeof value!=='string')throw err(400,'Требуется email');const s=value.trim().toLowerCase();if(s.length<5||s.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))throw err(400,'Некорректный email');return s;};
export function registerStaffRoutes(app,{prefix, pool, forTenant, bodyOf}){
  app.get(prefix+'/staff',req=>forTenant(req,['owner','manager'],async(db,session)=>{
    const members=await db.query(
      'SELECT m.account_id,a.email,m.role FROM industry.memberships m JOIN industry.accounts a ON a.id=m.account_id WHERE m.tenant_id=$1 ORDER BY a.email LIMIT 200',[session.tenant_id]);
    const invites=await db.query(
      'SELECT id,email,role,expires_at,accepted_at,revoked_at,created_at FROM industry.invitations WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50',[session.tenant_id]);
    return {members:members.rows,invitations:invites.rows};
  }));
  app.post(prefix+'/staff/invitations',(req,reply)=>forTenant(req,['owner','manager'],async(db,session,actorRole)=>{
    const b=bodyOf(req),email=emailOf(b.email),role=b.role;
    if(!ROLES.includes(role))throw err(400,'Недопустимая роль');
    if(actorRole==='manager'&&role!=='operator'&&role!=='viewer')throw err(403,'Управляющий не может назначать управляющих');
    const existing=await db.query('SELECT 1 FROM industry.memberships m JOIN industry.accounts a ON a.id=m.account_id WHERE m.tenant_id=$1 AND a.email=$2',[session.tenant_id,email]);
    if(existing.rowCount)throw err(409,'Сотрудник уже состоит в организации');
    const token=randomBytes(32).toString('hex');
    await db.query('UPDATE industry.invitations SET revoked_at=now() WHERE tenant_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL',[session.tenant_id,email]);
    const insert=await db.query("INSERT INTO industry.invitations(tenant_id,email,role,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '48 hours') RETURNING id,email,role,expires_at",[session.tenant_id,email,role,sha256(token),session.account_id]);
    await recordChange(db,session.tenant_id,session.account_id,'staff.invited',insert.rows[0].id);
    reply.code(201);
    // Raw token returned exactly once; never stored or logged on server.
    return {invitation:insert.rows[0],token};
  }));
  app.post(prefix+'/staff/invitations/:id/revoke',req=>forTenant(req,['owner','manager'],async(db,session,actorRole)=>{
    const id=parseId(req.params.id);
    const found=await db.query('SELECT role,accepted_at FROM industry.invitations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[session.tenant_id,id]);
    if(!found.rowCount)throw err(404,'Приглашение не найдено');
    if(actorRole==='manager'&&found.rows[0].role==='manager')throw err(403,'Недостаточно прав');
    if(found.rows[0].accepted_at)throw err(409,'Приглашение уже использовано');
    await db.query('UPDATE industry.invitations SET revoked_at=now() WHERE tenant_id=$1 AND id=$2',[session.tenant_id,id]);
    await recordChange(db,session.tenant_id,session.account_id,'staff.invitation_revoked',id);
    return {revoked:true};
  }));
  // Public acceptance is protected by a single-use random 256-bit token,
  // strict same-origin POST enforcement and a 48h expiry; no public registration.
  app.post(prefix+'/staff/invitations/accept',async req=>{
    const b=bodyOf(req);
    const token=b.token;
    if(typeof token!=='string'||!inviteToken.test(token))throw err(400,'Неверное приглашение');
    if(typeof b.password!=='string'||b.password.length<12||b.password.length>200)throw err(400,'Пароль должен иметь 12–200 символов');
    const tokenHash=sha256(token);
    const lookup=await pool.query('SELECT tenant_id FROM industry.resolve_invitation($1)',[tokenHash]);
    if(!lookup.rowCount)throw err(404,'Приглашение недействительно или истекло');
    const tenantId=lookup.rows[0].tenant_id;
    return withTenant(pool,tenantId,async db=>{
      const inv=await db.query(
        'SELECT id,email,role FROM industry.invitations WHERE tenant_id=$1 AND token_hash=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE',[tenantId,tokenHash]);
      if(!inv.rowCount)throw err(404,'Приглашение недействительно или истекло');
      const item=inv.rows[0];
      let account=(await db.query('SELECT id,password_hash FROM industry.accounts WHERE email=$1',[item.email])).rows[0];
      if(account){
        if(!await verifyPassword(b.password,account.password_hash))throw err(401,'Неверные данные приглашения');
      }else{
        const hash=await hashPassword(b.password);
        const insert=await db.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) ON CONFLICT (email) DO NOTHING RETURNING id',[item.email,hash]);
        if(!insert.rowCount)throw err(409,'Аккаунт уже создан, повторите с существующим паролем');
        account={id:insert.rows[0].id};
      }
      const member=await db.query('SELECT 1 FROM industry.memberships WHERE tenant_id=$1 AND account_id=$2',[tenantId,account.id]);
      if(member.rowCount)throw err(409,'Сотрудник уже состоит в компании');
      await db.query('INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,$3)',[tenantId,account.id,item.role]);
      await db.query('UPDATE industry.invitations SET accepted_at=now() WHERE tenant_id=$1 AND id=$2',[tenantId,item.id]);
      await recordChange(db,tenantId,account.id,'staff.joined',item.id);
      return {accepted:true};
    });
  });
  app.patch(prefix+'/staff/:accountId',req=>forTenant(req,['owner','manager'],async(db,session,actorRole)=>{
    const accountId=parseId(req.params.accountId),role=bodyOf(req).role;
    if(!ROLES.includes(role))throw err(400,'Недопустимая роль');
    if(actorRole==='manager'&&role==='manager')throw err(403,'Недостаточно прав');
    const old=await db.query('SELECT role FROM industry.memberships WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE',[session.tenant_id,accountId]);
    if(!old.rowCount)throw err(404,'Сотрудник не найден');
    if(old.rows[0].role==='owner'||(actorRole==='manager'&&old.rows[0].role==='manager'))throw err(403,'Изменение роли запрещено');
    await db.query('UPDATE industry.memberships SET role=$1 WHERE tenant_id=$2 AND account_id=$3',[role,session.tenant_id,accountId]);
    await recordChange(db,session.tenant_id,session.account_id,'staff.role_changed',accountId);
    return {accountId,role};
  }));
  app.delete(prefix+'/staff/:accountId',req=>forTenant(req,['owner','manager'],async(db,session,actorRole)=>{
    const accountId=parseId(req.params.accountId);
    const old=await db.query('SELECT role FROM industry.memberships WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE',[session.tenant_id,accountId]);
    if(!old.rowCount)throw err(404,'Сотрудник не найден');
    if(old.rows[0].role==='owner'||(actorRole==='manager'&&old.rows[0].role==='manager'))throw err(403,'Удаление этой роли запрещено');
    await db.query('DELETE FROM industry.memberships WHERE tenant_id=$1 AND account_id=$2',[session.tenant_id,accountId]);
    await db.query('DELETE FROM industry.sessions WHERE tenant_id=$1 AND account_id=$2',[session.tenant_id,accountId]);
    await recordChange(db,session.tenant_id,session.account_id,'staff.removed',accountId);
    return {removed:true};
  }));
}
