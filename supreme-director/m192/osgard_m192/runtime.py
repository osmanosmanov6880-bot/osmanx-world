"""Offline, tenant-scoped task execution for M192 reference integration.

All operations are local. There are no subprocess, network or external effectors.
This implements reference functionality, not deployment of six upstreams.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any
import hmac
import json
import re
import secrets
import sqlite3
import time
import uuid

ROLES = frozenset({'owner', 'operator', 'viewer'})
OPS = {
    'titan.tasks.create': {'owner', 'operator'},
    'titan.tasks.list': ROLES,
    'commerce.customers.create': {'owner', 'operator'},
    'commerce.customers.list': ROLES,
    'commerce.deals.create': {'owner', 'operator'},
    'commerce.deals.list': ROLES,
    'experience.book': {'owner', 'operator'},
    'experience.bookings.list': ROLES,
    'experience.cancel': {'owner', 'operator'},
    'nexus.decisions.create': {'owner', 'operator'},
    'nexus.decisions.list': ROLES,
    'genesis.scenes.save': {'owner', 'operator'},
    'genesis.scenes.get': ROLES,
    'orbital.emulator.enqueue': {'owner'},
    'orbital.emulator.ack': {'owner'},
    'orbital.emulator.list': {'owner'},
    'titan.audit.list': {'owner'},
}
WRITES = frozenset({op for op in OPS if not (op.endswith('.list') or op.endswith('.get'))})
KEY_RE = re.compile(r'^[A-Za-z0-9_:-]{8,100}$')
NAME_RE = re.compile(r'^[\w .@+-]{1,100}$', re.UNICODE)
UUID_RE = re.compile(r'^[0-9a-f]{32}$')
STAGES = frozenset({'new', 'qualified', 'proposal', 'won', 'lost'})


class DirectorError(Exception):
    status = 400


class Unauthorized(DirectorError):
    status = 403


class Conflict(DirectorError):
    status = 409


class Invalid(DirectorError):
    status = 422


def canonical(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), allow_nan=False,
                      ensure_ascii=True)


def _now() -> int:
    return int(time.time())


def _identifier(text: Any, label='identifier') -> str:
    if not isinstance(text, str) or not UUID_RE.fullmatch(text):
        raise Invalid(f'{label} must be lowercase UUID hex')
    return text


def _text(value: Any, label: str, limit: int = 160) -> str:
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= limit:
        raise Invalid(f'{label} must be 1..{limit} nonblank characters')
    if any(ord(c) < 32 for c in value):
        raise Invalid(f'{label} contains control characters')
    return value.strip()


def _object(p: Any, required: set[str], optional: set[str] | None = None) -> dict:
    if not isinstance(p, dict):
        raise Invalid('payload must be an object')
    keys = set(p)
    if not required.issubset(keys) or keys - required - (optional or set()):
        raise Invalid('unexpected or missing payload fields')
    return p


def _uid() -> str:
    return uuid.uuid4().hex


def _secret_hash(token: str) -> str:
    return sha256(token.encode('utf-8')).hexdigest()


class Director:
    def __init__(self, database: str | Path, *, clock=None):
        self.database = Path(database)
        self.clock = clock or _now

    @contextmanager
    def connect(self, *, transaction=False):
        self.database.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.database, isolation_level=None, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA busy_timeout=10000')
        if transaction:
            db.execute('BEGIN IMMEDIATE')
        try:
            yield db
            if transaction:
                db.execute('COMMIT')
        except BaseException:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()

    def initialize(self):
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('PRAGMA synchronous=FULL')
            db.executescript('''
            CREATE TABLE IF NOT EXISTS tenants (
              id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS api_keys (
              hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
              actor TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','operator','viewer')),
              expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS requests (
              tenant_id TEXT NOT NULL, idem_key TEXT NOT NULL, op TEXT NOT NULL,
              request_sha TEXT NOT NULL, response_json TEXT NOT NULL,
              PRIMARY KEY(tenant_id,idem_key));
            CREATE TABLE IF NOT EXISTS tasks (
              id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS tasks_tenant ON tasks(tenant_id,created_at);
            CREATE TABLE IF NOT EXISTS customers (
              id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
              contact TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS customers_tenant ON customers(tenant_id,created_at);
            CREATE TABLE IF NOT EXISTS deals (
              id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
              customer_id TEXT NOT NULL, title TEXT NOT NULL,
              amount_minor INTEGER NOT NULL CHECK(amount_minor>=0),
              stage TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS deals_tenant ON deals(tenant_id,created_at);
            CREATE TABLE IF NOT EXISTS bookings (
              id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, resource TEXT NOT NULL,
              customer_id TEXT NOT NULL, start_at INTEGER NOT NULL,
              end_at INTEGER NOT NULL, state TEXT NOT NULL,
              created_at INTEGER NOT NULL, CHECK(start_at<end_at));
            CREATE INDEX IF NOT EXISTS bookings_overlap ON bookings(tenant_id,resource,state,start_at,end_at);
            CREATE TABLE IF NOT EXISTS decisions (
              id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, question TEXT NOT NULL,
              alternatives_json TEXT NOT NULL, chosen TEXT NOT NULL,
              rationale TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS decisions_tenant ON decisions(tenant_id,created_at);
            CREATE TABLE IF NOT EXISTS scenes (
              tenant_id TEXT NOT NULL, scene_id TEXT NOT NULL, version INTEGER NOT NULL,
              body_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
              PRIMARY KEY(tenant_id,scene_id));
            CREATE TABLE IF NOT EXISTS scene_history (
              tenant_id TEXT NOT NULL, scene_id TEXT NOT NULL, version INTEGER NOT NULL,
              body_json TEXT NOT NULL, PRIMARY KEY(tenant_id,scene_id,version));
            CREATE TABLE IF NOT EXISTS simulator (
              id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, terminal TEXT NOT NULL,
              nonce TEXT NOT NULL, expires_at INTEGER NOT NULL,
              payload_json TEXT NOT NULL, transport_ack INTEGER NOT NULL DEFAULT 0,
              execution_ack INTEGER NOT NULL DEFAULT 0,
              UNIQUE(tenant_id,terminal,nonce));
            CREATE INDEX IF NOT EXISTS simulator_tenant ON simulator(tenant_id,terminal);
            CREATE TABLE IF NOT EXISTS audit (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
              actor TEXT NOT NULL, operation TEXT NOT NULL,
              request_sha TEXT NOT NULL, recorded_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS audit_tenant ON audit(tenant_id,sequence);
            ''')

    def provision(self, name: str, actor: str, role: str = 'owner', ttl_seconds: int = 86400):
        """Offline CLI only. No public endpoint can provision tokens or tenants."""
        _text(name, 'tenant name')
        if not isinstance(actor, str) or not NAME_RE.fullmatch(actor):
            raise Invalid('invalid operator name')
        if role not in ROLES:
            raise Invalid('unknown role')
        if not isinstance(ttl_seconds, int) or not 60 <= ttl_seconds <= 86400*30:
            raise Invalid('invalid ttl')
        tenant, token = _uid(), secrets.token_urlsafe(32)
        with self.connect(transaction=True) as db:
            db.execute('INSERT INTO tenants VALUES (?,?,?)', (tenant,name,self.clock()))
            db.execute('INSERT INTO api_keys(hash,tenant_id,actor,role,expires_at) VALUES (?,?,?,?,?)',
                       (_secret_hash(token),tenant,actor,role,self.clock()+ttl_seconds))
        return {'tenant_id':tenant, 'token':token, 'role':role, 'expires_at':self.clock()+ttl_seconds}

    def issue_token(self, owner_token: str, actor: str, role: str, ttl_seconds=86400):
        if role not in ROLES or not NAME_RE.fullmatch(actor or ''):
            raise Invalid('invalid actor or role')
        if not isinstance(ttl_seconds,int) or not 60 <= ttl_seconds <= 86400*30:
            raise Invalid('invalid ttl')
        token = secrets.token_urlsafe(32)
        with self.connect(transaction=True) as db:
            owner = self._identity(db,owner_token)
            if owner['role'] != 'owner':
                raise Unauthorized('owner required')
            db.execute('INSERT INTO api_keys(hash,tenant_id,actor,role,expires_at) VALUES (?,?,?,?,?)',
                       (_secret_hash(token),owner['tenant_id'],actor,role,self.clock()+ttl_seconds))
        return {'token':token,'role':role,'tenant_id':owner['tenant_id'],'expires_at':self.clock()+ttl_seconds}

    def _identity(self, db, token: str):
        if not isinstance(token,str) or not 20 <= len(token) <= 128:
            raise Unauthorized('invalid credential')
        row = db.execute('SELECT tenant_id, actor, role, expires_at, revoked FROM api_keys WHERE hash=?',
                         (_secret_hash(token),)).fetchone()
        if row is None or row['revoked'] or row['expires_at'] <= self.clock():
            raise Unauthorized('invalid or expired credential')
        return dict(row)

    def execute(self, token: str, op: str, payload: dict, idem_key: str | None = None):
        if op not in OPS:
            raise Invalid('unknown operation')
        if op in WRITES and (not isinstance(idem_key, str) or not KEY_RE.fullmatch(idem_key)):
            raise Invalid('writes require 8..100 character idempotency key')
        if not isinstance(payload,dict):
            raise Invalid('payload must be object')
        with self.connect(transaction=True) as db:
            identity = self._identity(db,token)
            if identity['role'] not in OPS[op]:
                raise Unauthorized('permission denied')
            tenant, actor = identity['tenant_id'], identity['actor']
            if op in WRITES:
                try:
                    hashed = _secret_hash(canonical({'op':op,'payload':payload}))
                except (TypeError, ValueError) as exc:
                    raise Invalid('invalid non-JSON payload value') from exc
                old = db.execute('SELECT op,request_sha,response_json FROM requests WHERE tenant_id=? AND idem_key=?',
                                 (tenant,idem_key)).fetchone()
                if old:
                    if old['request_sha'] != hashed or old['op'] != op:
                        raise Conflict('idempotency key reused with different request')
                    return json.loads(old['response_json'])
            result = self._apply(db,tenant,op,payload)
            if op in WRITES:
                db.execute('INSERT INTO requests VALUES (?,?,?,?,?)',
                           (tenant,idem_key,op,hashed,canonical(result)))
                db.execute('INSERT INTO audit(tenant_id,actor,operation,request_sha,recorded_at) VALUES (?,?,?,?,?)',
                           (tenant,actor,op,hashed,self.clock()))
            return result

    def _owns_customer(self, db, tenant, customer_id):
        _identifier(customer_id,'customer id')
        if not db.execute('SELECT 1 FROM customers WHERE tenant_id=? AND id=?',
                          (tenant,customer_id)).fetchone():
            raise Invalid('customer does not exist in tenant')

    def _apply(self, db, tenant, op, p):
        now = self.clock()
        if op == 'titan.tasks.create':
            _object(p,{'title'})
            value={'id':_uid(),'title':_text(p['title'],'title'), 'status':'open'}
            db.execute('INSERT INTO tasks VALUES (?,?,?,?,?)',(value['id'],tenant,value['title'],'open',now))
            return value
        if op == 'titan.tasks.list':
            _object(p,set())
            return {'tasks':[dict(x) for x in db.execute('SELECT id,title,status FROM tasks WHERE tenant_id=? ORDER BY created_at,id',(tenant,))]}
        if op == 'commerce.customers.create':
            _object(p,{'name','contact'})
            value={'id':_uid(),'name':_text(p['name'],'name'), 'contact':_text(p['contact'],'contact',200)}
            db.execute('INSERT INTO customers VALUES (?,?,?,?,?)',(value['id'],tenant,value['name'],value['contact'],now))
            return value
        if op == 'commerce.customers.list':
            _object(p,set())
            return {'customers':[dict(x) for x in db.execute('SELECT id,name,contact FROM customers WHERE tenant_id=? ORDER BY created_at,id',(tenant,))]}
        if op == 'commerce.deals.create':
            _object(p,{'customer_id','title','amount_minor','stage'})
            self._owns_customer(db,tenant,p['customer_id'])
            if type(p['amount_minor']) is not int or not 0 <= p['amount_minor'] <= 10**12:
                raise Invalid('amount_minor must be integer, >=0 and <=10^12')
            if not isinstance(p['stage'],str) or p['stage'] not in STAGES:
                raise Invalid('invalid deal stage')
            value={'id':_uid(),'customer_id':p['customer_id'],'title':_text(p['title'],'title'),
                   'amount_minor':p['amount_minor'],'stage':p['stage']}
            db.execute('INSERT INTO deals VALUES (?,?,?,?,?,?,?)',
                       (value['id'],tenant,value['customer_id'],value['title'],value['amount_minor'],value['stage'],now))
            return value
        if op == 'commerce.deals.list':
            _object(p,set())
            return {'deals':[dict(x) for x in db.execute('SELECT id,customer_id,title,amount_minor,stage FROM deals WHERE tenant_id=? ORDER BY created_at,id',(tenant,))]}
        if op == 'experience.book':
            _object(p,{'customer_id','resource','start_at','end_at'})
            self._owns_customer(db,tenant,p['customer_id'])
            start,end=p['start_at'],p['end_at']
            if type(start) is not int or type(end) is not int or not now-86400 <= start < end <= now+86400*366:
                raise Invalid('invalid UTC booking interval')
            if end-start > 86400:
                raise Invalid('booking interval too large')
            resource=_text(p['resource'],'resource',64)
            # Held by BEGIN IMMEDIATE. SQL interval overlap is [start,end).
            overlap=db.execute('''SELECT 1 FROM bookings WHERE tenant_id=? AND resource=? AND state='confirmed'
                AND start_at<? AND end_at>? LIMIT 1''',(tenant,resource,end,start)).fetchone()
            if overlap:
                raise Conflict('resource already booked in interval')
            value={'id':_uid(),'customer_id':p['customer_id'],'resource':resource,'start_at':start,
                   'end_at':end,'state':'confirmed'}
            db.execute('INSERT INTO bookings VALUES (?,?,?,?,?,?,?,?)',
                       (value['id'],tenant,resource,p['customer_id'],start,end,'confirmed',now))
            return value
        if op == 'experience.bookings.list':
            _object(p,set())
            return {'bookings':[dict(x) for x in db.execute('SELECT id,customer_id,resource,start_at,end_at,state FROM bookings WHERE tenant_id=? ORDER BY start_at,id',(tenant,))]}
        if op == 'experience.cancel':
            _object(p,{'booking_id'})
            _identifier(p['booking_id'],'booking id')
            cur=db.execute("UPDATE bookings SET state='cancelled' WHERE id=? AND tenant_id=? AND state='confirmed'",
                           (p['booking_id'],tenant))
            if cur.rowcount!=1:
                raise Invalid('confirmed booking not found in tenant')
            return {'id':p['booking_id'],'state':'cancelled'}
        if op == 'nexus.decisions.create':
            _object(p,{'question','alternatives','chosen','rationale'})
            opts=p['alternatives']
            if not isinstance(opts,list) or not 2 <= len(opts) <= 20 or not all(isinstance(x,str) and x.strip() and len(x)<=100 for x in opts):
                raise Invalid('2..20 alternatives required')
            if len(set(opts))!=len(opts) or not isinstance(p['chosen'],str) or p['chosen'] not in opts:
                raise Invalid('selected alternative must be unique and present')
            value={'id':_uid(),'question':_text(p['question'],'question',300),
                   'alternatives':opts,'chosen':p['chosen'],'rationale':_text(p['rationale'],'rationale',600)}
            db.execute('INSERT INTO decisions VALUES (?,?,?,?,?,?,?)',
                       (value['id'],tenant,value['question'],canonical(opts),value['chosen'],value['rationale'],now))
            return value
        if op == 'nexus.decisions.list':
            _object(p,set())
            rows=db.execute('SELECT id,question,alternatives_json,chosen,rationale FROM decisions WHERE tenant_id=? ORDER BY created_at,id',(tenant,))
            return {'decisions':[{'id':x['id'],'question':x['question'],'alternatives':json.loads(x['alternatives_json']),
                                  'chosen':x['chosen'],'rationale':x['rationale']} for x in rows]}
        if op == 'genesis.scenes.save':
            _object(p,{'scene_id','expected_version','nodes'})
            scene=_text(p['scene_id'],'scene id',64)
            version=p['expected_version']
            if type(version) is not int or version<0:
                raise Invalid('expected_version must be nonnegative integer')
            nodes=p['nodes']
            if not isinstance(nodes,list) or len(nodes)>300:
                raise Invalid('nodes must be bounded array')
            seen=set()
            for node in nodes:
                _object(node,{'id','kind','position'})
                nid=_text(node['id'],'node id',64)
                if nid in seen or not isinstance(node['kind'],str) or node['kind'] not in ('mesh','light','camera'):
                    raise Invalid('invalid node id or kind')
                seen.add(nid)
                xyz=node['position']
                if not isinstance(xyz,list) or len(xyz)!=3 or any(type(v) not in (int,float) or not -10000<=v<=10000 for v in xyz):
                    raise Invalid('invalid node position')
            previous=db.execute('SELECT version FROM scenes WHERE tenant_id=? AND scene_id=?',(tenant,scene)).fetchone()
            actual=previous['version'] if previous else 0
            if actual!=version:
                raise Conflict('scene version conflict')
            body=canonical({'schema':'osgard.scene/1','scene_id':scene,'nodes':nodes})
            if len(body)>256000:
                raise Invalid('scene too large')
            new_version=version+1
            db.execute('INSERT INTO scene_history VALUES (?,?,?,?)',(tenant,scene,new_version,body))
            db.execute('INSERT INTO scenes VALUES (?,?,?,?,?) ON CONFLICT(tenant_id,scene_id) DO UPDATE SET version=excluded.version,body_json=excluded.body_json,updated_at=excluded.updated_at',
                       (tenant,scene,new_version,body,now))
            return {'scene_id':scene,'version':new_version,'node_count':len(nodes)}
        if op == 'genesis.scenes.get':
            _object(p,{'scene_id'},{'version'})
            scene=_text(p['scene_id'],'scene id',64)
            if 'version' in p:
                if type(p['version']) is not int or p['version']<=0:
                    raise Invalid('invalid scene version')
                row=db.execute('SELECT version,body_json FROM scene_history WHERE tenant_id=? AND scene_id=? AND version=?',
                               (tenant,scene,p['version'])).fetchone()
            else:
                row=db.execute('SELECT version,body_json FROM scenes WHERE tenant_id=? AND scene_id=?',(tenant,scene)).fetchone()
            if not row:
                raise Invalid('scene/version not found for tenant')
            return {'version':row['version'],'scene':json.loads(row['body_json'])}
        if op == 'orbital.emulator.enqueue':
            _object(p,{'terminal','nonce','expires_at','command'})
            terminal=_text(p['terminal'],'terminal',64)
            nonce=_text(p['nonce'],'nonce',100)
            expiry=p['expires_at']
            if not KEY_RE.fullmatch(nonce) or type(expiry) is not int or not now < expiry <= now+3600:
                raise Invalid('invalid nonce or TTL; max 1 hour')
            command=_text(p['command'],'command',128)
            # There is no device adapter. Command is only an inert string.
            value={'id':_uid(),'terminal':terminal,'nonce':nonce,'expires_at':expiry,
                   'command':command,'mode':'SIMULATION_ONLY'}
            try:
                db.execute('INSERT INTO simulator(id,tenant_id,terminal,nonce,expires_at,payload_json) VALUES (?,?,?,?,?,?)',
                           (value['id'],tenant,terminal,nonce,expiry,canonical(value)))
            except sqlite3.IntegrityError as exc:
                raise Conflict('replayed terminal nonce') from exc
            return value
        if op == 'orbital.emulator.ack':
            _object(p,{'command_id','phase'})
            _identifier(p['command_id'],'command id')
            phase=p['phase']
            if not isinstance(phase,str) or phase not in ('transport','execution'):
                raise Invalid('invalid acknowledgement phase')
            row=db.execute('SELECT terminal,expires_at,transport_ack,execution_ack FROM simulator WHERE tenant_id=? AND id=?',
                           (tenant,p['command_id'])).fetchone()
            if not row or row['expires_at']<=now:
                raise Invalid('unknown or expired simulated command')
            if phase=='execution' and not row['transport_ack']:
                raise Conflict('transport acknowledgement required first')
            if phase=='transport':
                db.execute('UPDATE simulator SET transport_ack=1 WHERE tenant_id=? AND id=?',(tenant,p['command_id']))
            else:
                db.execute('UPDATE simulator SET execution_ack=1 WHERE tenant_id=? AND id=?',(tenant,p['command_id']))
            return {'command_id':p['command_id'],'phase':phase,'mode':'SIMULATION_ONLY'}
        if op == 'orbital.emulator.list':
            _object(p,set())
            return {'commands':[dict(x) for x in db.execute('SELECT id,terminal,nonce,expires_at,transport_ack,execution_ack FROM simulator WHERE tenant_id=? ORDER BY expires_at,id',(tenant,))], 'mode':'SIMULATION_ONLY'}
        if op == 'titan.audit.list':
            _object(p,set())
            return {'audit':[dict(x) for x in db.execute('SELECT sequence,actor,operation,request_sha,recorded_at FROM audit WHERE tenant_id=? ORDER BY sequence DESC LIMIT 200',(tenant,))]}
        raise Invalid('operation not implemented')
