"""Wave 14: ephemeral HMAC-SHA256 local, one-time execution permits.

A permit binds the original validated TaskEnvelope, identity, capability,
resource scopes, budget ceiling, and a short time window. HMAC keys are
supplied only by a trusted in-process caller; never stored in SQLite and
never exposed over HTTP. This is not external identity authentication
or independent signed provenance.
"""
from __future__ import annotations
from hashlib import sha256
import hmac
import re
import secrets
from typing import Mapping,Any

from .contracts import (
    ACTOR_RE,TENANT_RE,canonical,digest,validate_task,
    ContractError,
)

PERMIT_SCHEMA="osgard.local-execution-permit/1"
HEX64=re.compile(r"^[a-f0-9]{64}$")
NONCE_RE=re.compile(r"^[a-f0-9]{32}$")

class PermitDenied(ValueError):
    pass

class LocalPermitAuthority:
    def __init__(self,secret:bytes,*,key_id:str="local-ephemeral-v1"):
        if (type(secret) is not bytes or len(secret)<32 or
            len(secret)>128 or type(key_id) is not str or
            not re.fullmatch(r"[A-Za-z0-9_-]{8,64}",key_id)):
            raise PermitDenied("Trusted signing key >=32 bytes and key id required")
        self._secret=secret
        self.key_id=key_id

    def _signature(self,payload:dict)->str:
        return hmac.new(self._secret,canonical(payload),sha256).hexdigest()

    @staticmethod
    def _verified_authorization(auth:Any,*,tenant:str,actor:str,
                                scopes:set[str],now:int)->dict:
        if type(auth) is not dict or set(auth)!={
            "task","digest","authorization","external_execution_permitted"}:
            raise PermitDenied("Exact validated envelope required")
        task=auth["task"]
        if (type(task) is not dict or auth["digest"]!=digest(task) or
            auth["authorization"]!="LOCAL_VALIDATION_ONLY" or
            auth["external_execution_permitted"] is not False):
            raise PermitDenied("Forged validation context")
        try:
            return validate_task(task,tenant_id=tenant,actor_id=actor,
                 allow_capabilities={"sandbox.evaluate"},allowed_scopes=scopes,now=now)
        except ContractError as exc:
            # Identity/scopes are intentionally fail-closed but must not leak
            # internal validation details through the permit API.
            raise PermitDenied("Untrusted task binding") from exc

    def issue(self,authorization:dict,*,tenant:str,actor:str,scopes:set[str],
              now:int,units:int=1,ttl_seconds:int=30)->dict:
        checked=self._verified_authorization(
             authorization,tenant=tenant,actor=actor,scopes=scopes,now=now)
        if (type(units) is not int or not 1<=units<=100 or
            type(ttl_seconds) is not int or not 1<=ttl_seconds<=120):
            raise PermitDenied("Resource approval must be bounded")
        task=checked["task"]
        expires=min(task["expires_at"],now+ttl_seconds)
        if expires<=now:
            raise PermitDenied("Task has no executable time remaining")
        payload={
           "schema":PERMIT_SCHEMA,"key_id":self.key_id,
           "nonce":secrets.token_hex(16),
           "tenant_id":tenant,"actor_id":actor,"task_id":task["task_id"],
           "task_sha256":checked["digest"],
           "capability":task["capability"],
           "scopes":sorted(scopes),"units":units,
           "issued_at":now,"expires_at":expires,
           "external_execution_authorized":False}
        return {"payload":payload,"signature":self._signature(payload)}

    def verify(self,permit:Any,authorization:dict,*,tenant:str,actor:str,
               scopes:set[str],now:int)->dict:
        checked=self._verified_authorization(
             authorization,tenant=tenant,actor=actor,scopes=scopes,now=now)
        if type(permit) is not dict or set(permit)!={"payload","signature"}:
            raise PermitDenied("Unknown permit shape")
        payload=permit["payload"]
        if (type(payload) is not dict or set(payload)!={
            "schema","key_id","nonce","tenant_id","actor_id","task_id",
            "task_sha256","capability","scopes","units","issued_at",
            "expires_at","external_execution_authorized"}):
            raise PermitDenied("Unknown signed permit fields")
        signature=permit["signature"]
        if type(signature) is not str or not HEX64.fullmatch(signature):
            raise PermitDenied("Malformed HMAC signature")
        if not hmac.compare_digest(signature,self._signature(payload)):
            raise PermitDenied("Untrusted or altered permit signature")
        task=checked["task"]
        if (payload["schema"]!=PERMIT_SCHEMA or
            payload["key_id"]!=self.key_id or
            type(payload["nonce"]) is not str or not NONCE_RE.fullmatch(payload["nonce"]) or
            payload["tenant_id"]!=tenant or payload["actor_id"]!=actor or
            payload["task_id"]!=task["task_id"] or
            payload["task_sha256"]!=checked["digest"] or
            payload["capability"]!="sandbox.evaluate" or
            payload["external_execution_authorized"] is not False or
            type(payload["scopes"]) is not list or
            payload["scopes"]!=sorted(scopes) or
            type(payload["units"]) is not int or not 1<=payload["units"]<=100 or
            type(payload["issued_at"]) is not int or
            type(payload["expires_at"]) is not int or
            not payload["issued_at"]<=now<payload["expires_at"] or
            payload["expires_at"]>task["expires_at"] or
            payload["expires_at"]-payload["issued_at"]>120):
            raise PermitDenied("Signed permit no longer authorizes this job")
        return payload.copy()
