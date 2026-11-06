"""Versioned TaskEnvelope/ResultEnvelope validation without dispatch authority.

This implements part of TITAN-X06; it does not integrate the six original
worker products and cannot issue real execution authorization.
"""
from __future__ import annotations

from hashlib import sha256
import json
import re
import sqlite3
from typing import Any, Mapping
import uuid

SCHEMA_TASK='osgard.task-envelope/1'
SCHEMA_RESULT='osgard.result-envelope/1'
IDEMPOTENCY_RE=re.compile(r'^[A-Za-z0-9._:-]{16,128}$')
TENANT_RE=re.compile(r'^[a-z0-9][a-z0-9_-]{2,63}$')
ACTOR_RE=re.compile(r'^[A-Za-z0-9][A-Za-z0-9._@:-]{2,127}$')
SCOPE_RE=re.compile(r'^(?:project|workspace|document):[A-Za-z0-9._:-]{1,100}$')
SECRET_NAMES={'access_token','auth_token','api_key','password','private_key','secret','refresh_token','bearer'}
MAX_BODY_BYTES=32768
MAX_DEPTH=12
MAX_TTL_SECONDS=3600
MAX_SKEW_SECONDS=60


class ContractError(ValueError):
    pass


def canonical(value: Any) -> bytes:
    try:
        return json.dumps(value,ensure_ascii=True,sort_keys=True,
                          separators=(',', ':'),allow_nan=False).encode('utf-8')
    except (TypeError,ValueError,OverflowError) as exc:
        raise ContractError('Not a canonical JSON payload') from exc


def digest(value: Any) -> str:
    return sha256(canonical(value)).hexdigest()


def _object(data: Any, expected: set[str]) -> dict:
    if type(data) is not dict or set(data)!=expected:
        raise ContractError('Envelope fields do not match the versioned contract')
    return data


def _uid(value: Any, name: str) -> str:
    if not isinstance(value,str):
        raise ContractError(name+' must be UUID')
    try:
        parsed=uuid.UUID(value)
    except (ValueError,AttributeError) as exc:
        raise ContractError(name+' must be UUID') from exc
    if str(parsed)!=value:
        raise ContractError(name+' must be canonical UUID')
    return value


def _safe_content(value: Any, depth: int=0) -> None:
    if depth>MAX_DEPTH:
        raise ContractError('Nested body is too deep')
    if value is None or type(value) in (bool,int,str):
        if type(value) is int and abs(value)>2**53-1:
            raise ContractError('Unsafe JSON integer precision')
        return
    if type(value) is list:
        for child in value:_safe_content(child,depth+1)
        return
    if type(value) is dict:
        for key,child in value.items():
            if type(key) is not str or not key or key.lower() in SECRET_NAMES:
                raise ContractError('Secret or invalid object key is prohibited')
            _safe_content(child,depth+1)
        return
    raise ContractError('Unsupported body type')


def _body(value: Any) -> dict:
    if type(value) is not dict:
        raise ContractError('Body must be an object')
    _safe_content(value)
    if len(canonical(value))>MAX_BODY_BYTES:
        raise ContractError('Payload too large')
    return value


def validate_task(data: Any, *, tenant_id: str, actor_id: str,
                  allow_capabilities: set[str], allowed_scopes: set[str],
                  now: int) -> dict:
    """Explicit identity binding and capability deny-by-default; never dispatches."""
    p=_object(data,{'schema','task_id','tenant_id','actor_id','capability',
                    'issued_at','expires_at','idempotency_key','resource_scopes',
                    'body'})
    if p['schema']!=SCHEMA_TASK:
        raise ContractError('Unknown TaskEnvelope schema')
    _uid(p['task_id'],'task_id')
    if type(tenant_id) is not str or not TENANT_RE.fullmatch(tenant_id):
        raise ContractError('Expected tenant binding invalid')
    if p['tenant_id']!=tenant_id or type(p['tenant_id']) is not str:
        raise ContractError('Task tenant binding mismatch')
    if type(actor_id) is not str or not ACTOR_RE.fullmatch(actor_id):
        raise ContractError('Expected actor binding invalid')
    if p['actor_id']!=actor_id:
        raise ContractError('Task actor binding mismatch')
    if (type(p['capability']) is not str or p['capability'] not in allow_capabilities
            or not re.fullmatch(r'[a-z][a-z0-9_.:-]{2,63}',p['capability'])):
        raise ContractError('Capability not granted')
    if type(now) is not int or now<0:
        raise ContractError('now must be integer epoch seconds')
    issued,expires=p['issued_at'],p['expires_at']
    if (type(issued) is not int or type(expires) is not int
            or expires<issued or expires-issued>MAX_TTL_SECONDS
            or issued>now+MAX_SKEW_SECONDS or expires<now):
        raise ContractError('Task expired, premature or TTL exceeds policy')
    if type(p['idempotency_key']) is not str or not IDEMPOTENCY_RE.fullmatch(p['idempotency_key']):
        raise ContractError('Invalid idempotency key')
    scopes=p['resource_scopes']
    if (type(scopes) is not list or not scopes or len(scopes)>30
            or any(type(s) is not str or not SCOPE_RE.fullmatch(s) for s in scopes)
            or len(set(scopes))!=len(scopes)
            or not set(scopes).issubset(allowed_scopes)):
        raise ContractError('Resource scopes denied or malformed')
    _body(p['body'])
    return {'task':p.copy(),'digest':digest(p),'authorization':'LOCAL_VALIDATION_ONLY',
            'external_execution_permitted':False}


def validate_result(data: Any, *, task: Mapping[str,Any], now: int) -> dict:
    p=_object(data,{'schema','result_id','task_id','task_digest','tenant_id',
                    'status','completed_at','body','error_code'})
    if p['schema']!=SCHEMA_RESULT:
        raise ContractError('Unknown ResultEnvelope schema')
    _uid(p['result_id'],'result_id')
    source=task.get('task')
    if type(source) is not dict or task.get('digest')!=digest(source):
        raise ContractError('Untrusted task envelope context')
    if p['task_id']!=source['task_id'] or p['task_digest']!=task['digest']:
        raise ContractError('Result does not bind original task digest')
    if p['tenant_id']!=source['tenant_id']:
        raise ContractError('Result crosses tenant boundary')
    if p['status'] not in ('ok','failed','cancelled'):
        raise ContractError('Unsupported result status')
    if (type(p['completed_at']) is not int or p['completed_at']<source['issued_at']
            or p['completed_at']>source['expires_at']
            or type(now) is not int or p['completed_at']>now+MAX_SKEW_SECONDS):
        raise ContractError('Result time is outside issued-task validity')
    if p['status']=='ok' and p['error_code'] is not None:
        raise ContractError('Success cannot have error code')
    if p['status']!='ok' and (type(p['error_code']) is not str or
                               not re.fullmatch(r'[A-Z][A-Z0-9_]{2,63}',p['error_code'])):
        raise ContractError('Failure/cancel requires machine error code')
    _body(p['body'])
    return {'result':p.copy(),'digest':digest(p),'result_verified_against_task':True,
            'worker_execution_independently_verified':False}


class ReplayLedger:
    """A durable local dedupe record. No executor is run by this class."""
    def __init__(self,path: str):
        self.path=str(path)
        with sqlite3.connect(self.path,timeout=15,isolation_level=None) as c:
            c.execute('PRAGMA journal_mode=WAL')
            c.execute('CREATE TABLE IF NOT EXISTS envelope_claims ('
                'tenant TEXT NOT NULL, idem TEXT NOT NULL, digest TEXT NOT NULL, '
                'state TEXT NOT NULL CHECK(state IN (\'claimed\',\'completed\')), '
                'result_digest TEXT, PRIMARY KEY(tenant,idem))')

    def claim(self,validated: Mapping[str,Any]) -> str:
        task=validated.get('task')
        if type(task) is not dict or validated.get('digest')!=digest(task):
            raise ContractError('A validated and unchanged task is required')
        tenant,key=task['tenant_id'],task['idempotency_key']
        with sqlite3.connect(self.path,timeout=15,isolation_level=None) as db:
            db.execute('BEGIN IMMEDIATE')
            old=db.execute('SELECT digest FROM envelope_claims WHERE tenant=? AND idem=?',
                           (tenant,key)).fetchone()
            if old:
                if old[0]!=validated['digest']:
                    raise ContractError('Idempotency key reused for different task')
                return 'DUPLICATE_NO_EFFECT'
            db.execute('INSERT INTO envelope_claims(tenant,idem,digest,state,result_digest) '
                       'VALUES(?,?,?,\'claimed\',NULL)',(tenant,key,validated['digest']))
            db.commit()
            return 'CLAIMED_LOCAL_ONLY'

    def finish(self,validated_task: Mapping[str,Any],validated_result: Mapping[str,Any]) -> str:
        t=validated_task['task']
        r=validated_result.get('result')
        if (type(r) is not dict or validated_result.get('digest')!=digest(r)
                or r['task_digest']!=validated_task['digest']):
            raise ContractError('Result proof does not bind task')
        with sqlite3.connect(self.path,timeout=15,isolation_level=None) as db:
            db.execute('BEGIN IMMEDIATE')
            old=db.execute('SELECT digest,state,result_digest FROM envelope_claims '
                           'WHERE tenant=? AND idem=?',
                           (t['tenant_id'],t['idempotency_key'])).fetchone()
            if old is None or old[0]!=validated_task['digest']:
                raise ContractError('Unknown or mismatched local claim')
            if old[1]=='completed':
                if old[2]!=validated_result['digest']:
                    raise ContractError('Result changed after finalization')
                return 'ALREADY_COMPLETED_LOCAL_ONLY'
            db.execute("UPDATE envelope_claims SET state='completed',result_digest=? "
                       'WHERE tenant=? AND idem=? AND state=\'claimed\'',
                       (validated_result['digest'],t['tenant_id'],t['idempotency_key']))
            db.commit()
            return 'COMPLETED_LOCAL_RECORD_ONLY'
