"""TITAN-X23: project-scoped roles for an isolated local app builder.

Only the HTTP adapter's bearer-token-to-principal binding is authentication.
This local policy store NEVER treats actor/tenant strings from request JSON
as authenticated; bootstrap methods must only be called by trusted setup.
All mutating application operations must check permissions in THE SAME
BEGIN IMMEDIATE SQLite transaction that applies the mutation.
"""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import sqlite3
from typing import Any

from .contracts import ACTOR_RE
from .drafts import DraftDenied,LocalDraftStore,_identity

PERMISSIONS={
    "owner":frozenset(("spec.read","spec.write","record.read","record.write",
        "workflow.read","workflow.manage","workflow.run","preview.read","members.manage")),
    "editor":frozenset(("spec.read","spec.write","record.read","record.write",
        "workflow.read","workflow.manage","workflow.run","preview.read")),
    "operator":frozenset(("spec.read","record.read","record.write",
        "workflow.read","workflow.run","preview.read")),
    "viewer":frozenset(("spec.read","record.read","workflow.read","preview.read")),
}
CAPABILITIES=frozenset().union(*PERMISSIONS.values())

class AppAccessDenied(DraftDenied):
    pass

@dataclass(frozen=True)
class AppPrincipal:
    tenant: str
    actor: str

    def __post_init__(self)->None:
        if (type(self.tenant) is not str
            or type(self.actor) is not str or not ACTOR_RE.fullmatch(self.actor)):
            raise AppAccessDenied("Invalid server-side identity binding")
        # tenant regex and canonical project are checked by the service.


class LocalAppPolicy:
    """Closed roles, explicit bootstrap, revocation and same-DB authorization."""

    def __init__(self,drafts:LocalDraftStore):
        if type(drafts) is not LocalDraftStore:
            raise AppAccessDenied("A trusted local draft store is required")
        self.drafts=drafts
        with drafts._db() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS app_memberships(
                tenant TEXT NOT NULL,project_id TEXT NOT NULL,actor TEXT NOT NULL,
                role TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN(0,1)),
                revision INTEGER NOT NULL,PRIMARY KEY(tenant,project_id,actor));
            CREATE INDEX IF NOT EXISTS app_memberships_project
                ON app_memberships(tenant,project_id,active);
            CREATE TABLE IF NOT EXISTS app_membership_events(
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant TEXT NOT NULL,project_id TEXT NOT NULL,actor TEXT NOT NULL,
                operation TEXT NOT NULL,at_epoch INTEGER NOT NULL);""")

    @staticmethod
    def _actor(actor:str)->None:
        if type(actor) is not str or not ACTOR_RE.fullmatch(actor):
            raise AppAccessDenied("Invalid server verified actor ID")

    @staticmethod
    def _epoch(now:int)->None:
        if type(now) is not int or now<0:
            raise AppAccessDenied("Expected integer epoch seconds")

    def bootstrap_owner(self,*,tenant:str,project_id:str,actor:str,now:int)->dict:
        """One-time trusted provisioning only; no unauthenticated route."""
        _identity(tenant,project_id)
        self._actor(actor)
        self._epoch(now)
        with self.drafts._tx() as db:
            self.drafts._head(db,tenant,project_id)
            seen=db.execute("""SELECT 1 FROM app_memberships WHERE tenant=?
                AND project_id=? LIMIT 1""",(tenant,project_id)).fetchone()
            if seen:
                raise AppAccessDenied("Owner provisioning is permanently closed for project")
            db.execute("""INSERT INTO app_memberships
                (tenant,project_id,actor,role,active,revision)
                VALUES(?,?,?,'owner',1,1)""",(tenant,project_id,actor))
            db.execute("""INSERT INTO app_membership_events
                (tenant,project_id,actor,operation,at_epoch)
                VALUES(?,?,?,'BOOTSTRAP_OWNER',?)""",
                (tenant,project_id,actor,now))
            return {"role":"owner","revision":1,"privileged_local_setup":True,
                    "external_identity_verified":False}

    def require(self,db:sqlite3.Connection,*,tenant:str,project_id:str,
                actor:str,capability:str)->dict:
        _identity(tenant,project_id)
        self._actor(actor)
        if type(capability) is not str or capability not in CAPABILITIES:
            raise AppAccessDenied("No such application capability")
        # Never infer a permission from the application specification itself.
        membership=db.execute("""SELECT role,active,revision FROM app_memberships
            WHERE tenant=? AND project_id=? AND actor=?""",
            (tenant,project_id,actor)).fetchone()
        if (membership is None or membership["active"]!=1
            or capability not in PERMISSIONS.get(membership["role"],())):
            raise AppAccessDenied("Application role denies this operation")
        # Inconsistent project or cross-tenant references fail before performing IO.
        self.drafts._head(db,tenant,project_id)
        return {"role":membership["role"],"revision":membership["revision"],
                "capability":capability,"tenant":tenant,"project_id":project_id,
                "authenticated_from_request_body":False}

    def add_member(self,*,tenant:str,project_id:str,owner_actor:str,
                   member_actor:str,role:str,now:int)->dict:
        self._actor(member_actor)
        self._epoch(now)
        if role not in ("editor","operator","viewer"):
            raise AppAccessDenied("Only non-owner roles may be delegated")
        with self.drafts._tx() as db:
            current=self.require(db,tenant=tenant,project_id=project_id,
                                 actor=owner_actor,capability="members.manage")
            if owner_actor==member_actor:
                raise AppAccessDenied("Owner must not overwrite own role")
            found=db.execute("""SELECT active FROM app_memberships WHERE tenant=?
                AND project_id=? AND actor=?""",
                (tenant,project_id,member_actor)).fetchone()
            if found:
                db.execute("""UPDATE app_memberships SET role=?,active=1,
                    revision=revision+1 WHERE tenant=? AND project_id=? AND actor=?""",
                    (role,tenant,project_id,member_actor))
            else:
                db.execute("""INSERT INTO app_memberships
                    (tenant,project_id,actor,role,active,revision) VALUES(?,?,?,?,1,1)""",
                    (tenant,project_id,member_actor,role))
            db.execute("""INSERT INTO app_membership_events
                (tenant,project_id,actor,operation,at_epoch)
                VALUES(?,?,?,'DELEGATE_ROLE',?)""",
                (tenant,project_id,member_actor,now))
            return {"member":member_actor,"role":role,"active":True,
                    "production_authorized":False}

    def revoke_member(self,*,tenant:str,project_id:str,
                      owner_actor:str,member_actor:str,now:int)->dict:
        self._actor(member_actor)
        self._epoch(now)
        with self.drafts._tx() as db:
            self.require(db,tenant=tenant,project_id=project_id,actor=owner_actor,
                         capability="members.manage")
            if owner_actor==member_actor:
                raise AppAccessDenied("Owner may not revoke self using delegation API")
            changed=db.execute("""UPDATE app_memberships
                SET active=0,revision=revision+1
                WHERE tenant=? AND project_id=? AND actor=? AND role!='owner' AND active=1""",
                (tenant,project_id,member_actor)).rowcount
            if changed!=1:
                raise AppAccessDenied("No active delegable role to revoke")
            db.execute("""INSERT INTO app_membership_events
                (tenant,project_id,actor,operation,at_epoch)
                VALUES(?,?,?,'REVOKE_ROLE',?)""",(tenant,project_id,member_actor,now))
            return {"member":member_actor,"active":False,
                    "revocation_committed":True}

    def get_role(self,*,tenant:str,project_id:str,actor:str)->dict:
        with self.drafts._db() as db:
            permission=self.require(db,tenant=tenant,project_id=project_id,
                                    actor=actor,capability="spec.read")
            return {"role":permission["role"],"capabilities":sorted(
                PERMISSIONS[permission["role"]]),"production_authorized":False}
