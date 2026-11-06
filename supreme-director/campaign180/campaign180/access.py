"""TITAN-X07/X08: local identity-to-tenant mapping and deny-by-default RBAC.

No public login, JWT verification, product privileges, or execution authority.
authenticated_* arguments MUST originate from a separate verified auth adapter.
This package deliberately cannot dispatch tasks or grant production access.
"""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import re
import sqlite3
from typing import Mapping, Iterable, Any

from .contracts import ACTOR_RE, TENANT_RE, SCOPE_RE, ContractError, validate_task

_CAP = re.compile(r'^[a-z][a-z0-9_.:-]{2,63}$')
_ROLE = re.compile(r'^[a-z][a-z0-9_-]{1,31}$')
MAX_GRANT_TTL = 7 * 24 * 3600


class AccessDenied(ContractError):
    """Explicit denial, never a permissive fallback."""


def _identity(tenant: str, actor: str) -> None:
    if (type(tenant) is not str or not TENANT_RE.fullmatch(tenant)
            or type(actor) is not str or not ACTOR_RE.fullmatch(actor)):
        raise AccessDenied('Invalid server identity binding')


def _epoch(value: int) -> None:
    if type(value) is not int or value < 0:
        raise AccessDenied('Time must be integer epoch seconds')


class AccessDirectory:
    """Local provisioning and resource grants, not a production IdP.

    Provisioning methods are privileged library operations: do not expose them
    on an unauthenticated HTTP route. Every task check is read-only and never
    infers identity or rights from the untrusted task envelope.
    """

    def __init__(self, path: str | Path, role_capabilities: Mapping[str, Iterable[str]]):
        if not isinstance(role_capabilities, Mapping) or not role_capabilities:
            raise AccessDenied('No explicit role policy')
        policy: dict[str, frozenset[str]] = {}
        for role, grants in role_capabilities.items():
            if type(role) is not str or not _ROLE.fullmatch(role):
                raise AccessDenied('Invalid role name')
            if type(grants) not in (set, frozenset, tuple, list) or not grants:
                raise AccessDenied('Roles must declare explicit capabilities')
            caps = frozenset(grants)
            if len(caps) != len(grants) or any(type(cap) is not str or not _CAP.fullmatch(cap) for cap in caps):
                raise AccessDenied('Invalid role capability')
            policy[role] = caps
        self.policy = policy
        self.path = str(path)
        with self._connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS members (
                    tenant TEXT NOT NULL, actor TEXT NOT NULL,
                    role TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
                    revision INTEGER NOT NULL DEFAULT 1,
                    PRIMARY KEY (tenant,actor));
                CREATE TABLE IF NOT EXISTS scope_grants (
                    tenant TEXT NOT NULL, actor TEXT NOT NULL,
                    capability TEXT NOT NULL, scope TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    PRIMARY KEY (tenant,actor,capability,scope),
                    FOREIGN KEY (tenant,actor) REFERENCES members(tenant,actor));
                CREATE TABLE IF NOT EXISTS access_events (
                    id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, actor TEXT NOT NULL,
                    event TEXT NOT NULL, at_epoch INTEGER NOT NULL);
            """)

    def _connection(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA busy_timeout=15000')
        return db

    @contextmanager
    def _transaction(self):
        db = self._connection()
        try:
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _event(db: sqlite3.Connection, tenant: str, actor: str, event: str, now: int) -> None:
        db.execute('INSERT INTO access_events(tenant,actor,event,at_epoch) VALUES(?,?,?,?)',
                   (tenant, actor, event, now))

    def provision(self, tenant: str, actor: str, role: str, *, now: int) -> None:
        """Privileged local setup; replacement clears stale scope grants."""
        _identity(tenant, actor)
        _epoch(now)
        if role not in self.policy:
            raise AccessDenied('Unknown role')
        with self._transaction() as db:
            db.execute("""INSERT INTO members(tenant,actor,role,active,revision)
                          VALUES(?,?,?,1,1)
                          ON CONFLICT(tenant,actor) DO UPDATE SET
                          role=excluded.role,active=1,revision=members.revision+1""",
                       (tenant, actor, role))
            db.execute('DELETE FROM scope_grants WHERE tenant=? AND actor=?',(tenant,actor))
            self._event(db,tenant,actor,'PROVISION_RESET_GRANTS',now)

    def grant_scope(self, tenant: str, actor: str, capability: str, scope: str,
                    *, now: int, expires_at: int) -> None:
        _identity(tenant, actor)
        _epoch(now)
        _epoch(expires_at)
        if (type(capability) is not str or not _CAP.fullmatch(capability)
                or type(scope) is not str or not SCOPE_RE.fullmatch(scope)
                or not now < expires_at <= now + MAX_GRANT_TTL):
            raise AccessDenied('Invalid scope grant or TTL')
        with self._transaction() as db:
            found = db.execute('SELECT role,active FROM members WHERE tenant=? AND actor=?',
                               (tenant,actor)).fetchone()
            if not found or found[1] != 1 or capability not in self.policy.get(found[0],()):
                raise AccessDenied('Cannot grant beyond active member role')
            db.execute("""INSERT INTO scope_grants(tenant,actor,capability,scope,expires_at)
                          VALUES(?,?,?,?,?)
                          ON CONFLICT(tenant,actor,capability,scope)
                          DO UPDATE SET expires_at=excluded.expires_at""",
                       (tenant,actor,capability,scope,expires_at))
            db.execute('UPDATE members SET revision=revision+1 WHERE tenant=? AND actor=?',
                       (tenant,actor))
            self._event(db,tenant,actor,'SCOPE_GRANTED',now)

    def revoke_scope(self, tenant: str, actor: str, capability: str, scope: str, *, now: int) -> None:
        _identity(tenant,actor)
        _epoch(now)
        with self._transaction() as db:
            db.execute('DELETE FROM scope_grants WHERE tenant=? AND actor=? AND capability=? AND scope=?',
                       (tenant,actor,capability,scope))
            db.execute('UPDATE members SET revision=revision+1 WHERE tenant=? AND actor=?',
                       (tenant,actor))
            self._event(db,tenant,actor,'SCOPE_REVOKED',now)

    def revoke_member(self, tenant: str, actor: str, *, now: int) -> None:
        _identity(tenant, actor)
        _epoch(now)
        with self._transaction() as db:
            db.execute('UPDATE members SET active=0,revision=revision+1 WHERE tenant=? AND actor=?',
                       (tenant,actor))
            db.execute('DELETE FROM scope_grants WHERE tenant=? AND actor=?',(tenant,actor))
            self._event(db,tenant,actor,'MEMBER_REVOKED',now)

    def authorize_local(self, envelope: Any, *, authenticated_tenant: str,
                        authenticated_actor: str, now: int) -> dict:
        """Server identity is an explicit input, never read from the envelope.

        The caller is responsible for cryptographically authenticating the
        external principal; without that verified adapter this remains a local
        nonproduction policy check only.
        """
        _identity(authenticated_tenant, authenticated_actor)
        _epoch(now)
        if type(envelope) is not dict:
            raise AccessDenied('Untrusted task envelope type')
        with self._transaction() as db:
            member = db.execute('SELECT role,active,revision FROM members WHERE tenant=? AND actor=?',
                                (authenticated_tenant,authenticated_actor)).fetchone()
            if not member or member[1] != 1 or member[0] not in self.policy:
                raise AccessDenied('No active membership for server identity')
            caps = self.policy[member[0]]
            # Query is bound exclusively to authenticated identity, not body claims.
            rows = db.execute("""SELECT capability,scope FROM scope_grants
                                 WHERE tenant=? AND actor=? AND expires_at>?""",
                              (authenticated_tenant,authenticated_actor,now)).fetchall()
            current_cap = envelope.get('capability')
            scoped = {scope for cap,scope in rows if cap == current_cap}
            accepted = validate_task(
                envelope,tenant_id=authenticated_tenant,actor_id=authenticated_actor,
                allow_capabilities=set(caps),allowed_scopes=scoped,now=now)
            accepted['authorization'] = 'LOCAL_DIRECTORY_POLICY_ONLY'
            accepted['member_revision'] = member[2]
            accepted['external_execution_permitted'] = False
            return accepted
