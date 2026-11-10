"""TITAN-X16: local brief->spec->code->review->release-candidate ledger.

No model execution, code synthesis, independent acceptance, merge, payment,
or deployment occurs. Persistent content hashes and compare-and-swap transitions
prevent silent edits and status-only bypasses.
"""
from __future__ import annotations

from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path
import sqlite3
from typing import Any
import uuid

from .contracts import ACTOR_RE, TENANT_RE, _body, digest


class WorkflowDenied(ValueError):
    pass


STAGES = ("brief","spec","code","reviewed","rejected","release_candidate","cancelled")


class LocalProjectFlow:
    def __init__(self, path: str | Path):
        self.path=str(path)
        with self._connection() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS local_projects (
                tenant TEXT NOT NULL, project_id TEXT NOT NULL, owner TEXT NOT NULL,
                stage TEXT NOT NULL, version INTEGER NOT NULL,
                reviewer TEXT, head_hash TEXT NOT NULL,
                PRIMARY KEY (tenant,project_id));
            CREATE TABLE IF NOT EXISTS local_project_events (
                tenant TEXT NOT NULL, project_id TEXT NOT NULL, version INTEGER NOT NULL,
                stage TEXT NOT NULL, actor TEXT NOT NULL,
                content_digest TEXT NOT NULL, prev_hash TEXT NOT NULL,
                event_hash TEXT NOT NULL, at_epoch INTEGER NOT NULL,
                PRIMARY KEY(tenant,project_id,version));""")

    def _connection(self):
        c=sqlite3.connect(self.path,isolation_level=None,timeout=15)
        c.row_factory=sqlite3.Row
        c.execute("PRAGMA busy_timeout=15000")
        return c

    @contextmanager
    def _tx(self):
        db=self._connection()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _identifiers(tenant: str, actor: str, now: int) -> None:
        if (type(tenant) is not str or not TENANT_RE.fullmatch(tenant)
                or type(actor) is not str or not ACTOR_RE.fullmatch(actor)
                or type(now) is not int or now<0):
            raise WorkflowDenied("Invalid tenant, actor or time")

    @staticmethod
    def _project(project_id: str) -> None:
        try:
            if type(project_id) is not str or str(uuid.UUID(project_id))!=project_id:
                raise ValueError()
        except ValueError as exc:
            raise WorkflowDenied("Invalid canonical project UUID") from exc

    @staticmethod
    def _content(raw: Any) -> str:
        try:
            _body(raw)
        except ValueError as exc:
            raise WorkflowDenied("Invalid or unsafe content") from exc
        return digest(raw)

    def _append(self, db, row, *, stage: str, actor: str,
                content_digest: str, now: int) -> dict:
        new_version=row["version"]+1 if row else 1
        previous=row["head_hash"] if row else "0"*64
        tenant=row["tenant"] if row else self._pending_tenant
        project_id=row["project_id"] if row else self._pending_project
        item={"tenant":tenant,"project_id":project_id,"version":new_version,
              "stage":stage,"actor":actor,"content_digest":content_digest,
              "prev_hash":previous,"at_epoch":now}
        current=digest(item)
        db.execute("""INSERT INTO local_project_events
            (tenant,project_id,version,stage,actor,content_digest,prev_hash,event_hash,at_epoch)
            VALUES(?,?,?,?,?,?,?,?,?)""",
            (tenant,project_id,new_version,stage,actor,content_digest,previous,current,now))
        if row:
            db.execute("""UPDATE local_projects SET stage=?,version=?,head_hash=?
                WHERE tenant=? AND project_id=? AND version=?""",
                (stage,new_version,current,tenant,project_id,row["version"]))
        return {"tenant":tenant,"project_id":project_id,"stage":stage,
                "version":new_version,"head_hash":current,"production_release":False}

    def create(self, *, tenant: str, project_id: str, owner: str,
               brief: dict, now: int) -> dict:
        self._identifiers(tenant,owner,now)
        self._project(project_id)
        content=self._content(brief)
        with self._tx() as db:
            if db.execute("SELECT 1 FROM local_projects WHERE tenant=? AND project_id=?",
                          (tenant,project_id)).fetchone():
                raise WorkflowDenied("Project already exists for tenant")
            previous="0"*64
            event={"tenant":tenant,"project_id":project_id,"version":1,
                   "stage":"brief","actor":owner,"content_digest":content,
                   "prev_hash":previous,"at_epoch":now}
            h=digest(event)
            db.execute("""INSERT INTO local_projects
                (tenant,project_id,owner,stage,version,reviewer,head_hash)
                VALUES(?,?,?,'brief',1,NULL,?)""",(tenant,project_id,owner,h))
            db.execute("""INSERT INTO local_project_events
                (tenant,project_id,version,stage,actor,content_digest,prev_hash,event_hash,at_epoch)
                VALUES(?,?,1,'brief',?,?,?,?,?)""",
                (tenant,project_id,owner,content,previous,h,now))
            return {"project_id":project_id,"stage":"brief","version":1,
                    "head_hash":h,"production_release":False}

    def transition(self, *, tenant: str, project_id: str, actor: str,
                   expected_version: int, operation: str, evidence: dict,
                   now: int) -> dict:
        self._identifiers(tenant,actor,now)
        self._project(project_id)
        if type(expected_version) is not int or expected_version<1:
            raise WorkflowDenied("Expected monotonic version")
        if operation not in ("spec","code","approve","reject","revise","candidate","cancel","resume"):
            raise WorkflowDenied("Unknown workflow operation")
        content=self._content(evidence)
        with self._tx() as db:
            row=db.execute("SELECT * FROM local_projects WHERE tenant=? AND project_id=?",
                           (tenant,project_id)).fetchone()
            if not row:
                raise WorkflowDenied("Unknown project or tenant")
            if row["version"]!=expected_version:
                raise WorkflowDenied("Stale workflow version")
            target={"spec":("brief","spec"),
                    "code":("spec","code"),
                    "approve":("code","reviewed"),
                    "reject":("code","rejected"),
                    "revise":("rejected","code"),
                    "candidate":("reviewed","release_candidate"),
                    "cancel":(row["stage"],"cancelled"),
                    "resume":("cancelled","spec")}[operation]
            if operation=="cancel" and row["stage"]=="cancelled":
                raise WorkflowDenied("Project already cancelled")
            if row["stage"]!=target[0]:
                raise WorkflowDenied("Illegal workflow transition")
            review=operation in ("approve","reject")
            if review:
                if actor==row["owner"]:
                    raise WorkflowDenied("Self-review denied")
                if evidence.get("reviewed_content_digest")!=self._current_content_hash(
                        db,tenant,project_id):
                    raise WorkflowDenied("Review must bind latest code digest")
            elif actor!=row["owner"]:
                raise WorkflowDenied("Only project owner may author or nominate local candidate")
            result=self._append(db,row,stage=target[1],actor=actor,
                                content_digest=content,now=now)
            if review:
                db.execute("""UPDATE local_projects SET reviewer=?
                    WHERE tenant=? AND project_id=?""",(actor,tenant,project_id))
            if operation in ("cancel","resume"):
                db.execute("""UPDATE local_projects SET reviewer=NULL
                    WHERE tenant=? AND project_id=?""",(tenant,project_id))
            if operation=="candidate" and not row["reviewer"]:
                raise WorkflowDenied("No recorded nonowner reviewer")
            return result

    @staticmethod
    def _current_content_hash(db, tenant, project_id) -> str:
        row=db.execute("""SELECT content_digest FROM local_project_events
            WHERE tenant=? AND project_id=? AND stage='code'
            ORDER BY version DESC LIMIT 1""",(tenant,project_id)).fetchone()
        return row["content_digest"] if row else ""

    def candidate_manifest(self, *, tenant: str, project_id: str) -> dict:
        """X16: inspect a verified, frozen LOCAL release candidate.

        The manifest names exact brief/spec/code/review hashes and owner/reviewer;
        it does not sign, merge, execute or publish source. Cancellation and
        resume require a new spec/code/review chain before a new candidate.
        """
        summary=self.inspect(tenant=tenant,project_id=project_id)
        if summary["stage"]!="release_candidate":
            raise WorkflowDenied("Project has no reviewed local release candidate")
        with self._connection() as db:
            project=db.execute("""SELECT * FROM local_projects WHERE tenant=?
                AND project_id=?""",(tenant,project_id)).fetchone()
            events=db.execute("""SELECT stage,actor,content_digest,event_hash
                FROM local_project_events WHERE tenant=? AND project_id=?
                ORDER BY version""",(tenant,project_id)).fetchall()
            # Recheck the verified head while still holding a snapshot read
            # transaction (inspect() above validates full hash continuity).
            if project is None or project["head_hash"]!=summary["head_hash"]:
                raise WorkflowDenied("Candidate changed during inspection")
            if not events or events[-1]["event_hash"]!=project["head_hash"]:
                raise WorkflowDenied("Candidate event head changed")
            previous=events[-2] if len(events)>=2 else None
            if previous is None or previous["stage"]!="reviewed":
                raise WorkflowDenied("Candidate lacks immediately preceding approval")
            owner=project["owner"]
            reviewer=project["reviewer"]
            if not reviewer or reviewer==owner or previous["actor"]!=reviewer:
                raise WorkflowDenied("Candidate has no independent local reviewer")
            code=next((e for e in reversed(events[:-1])
                       if e["stage"]=="code"),None)
            spec=next((e for e in reversed(events[:-1])
                       if e["stage"]=="spec"),None)
            if not code or not spec or code["actor"]!=owner:
                raise WorkflowDenied("Candidate has no owned code/spec lineage")
            latest_code_index=next(i for i in range(len(events)-1,-1,-1)
                                   if events[i]["stage"]=="code")
            approved_index=next(i for i in range(len(events)-1,-1,-1)
                                if events[i]["stage"]=="reviewed")
            if latest_code_index>=approved_index:
                raise WorkflowDenied("Candidate code was not approved")
            report={"schema":"osgard.original180.release-candidate-manifest/1",
                "tenant":tenant,"project_id":project_id,
                "version":summary["version"],"head_hash":summary["head_hash"],
                "brief_sha256":events[0]["content_digest"],
                "spec_sha256":spec["content_digest"],
                "code_sha256":code["content_digest"],
                "review_sha256":previous["content_digest"],
                "owner":owner,"reviewer":reviewer,
                "release_candidate_only":True,
                "independent_identity_verified":False,
                "production_release":False}
            report["manifest_sha256"]=digest(report)
            return report

    def inspect(self, *, tenant: str, project_id: str) -> dict:
        if type(tenant) is not str or not TENANT_RE.fullmatch(tenant):
            raise WorkflowDenied("Explicit tenant required")
        self._project(project_id)
        db=self._connection()
        try:
            state=db.execute("SELECT * FROM local_projects WHERE tenant=? AND project_id=?",
                             (tenant,project_id)).fetchone()
            if not state:
                raise WorkflowDenied("Unknown tenant project")
            entries=db.execute("""SELECT * FROM local_project_events
                WHERE tenant=? AND project_id=? ORDER BY version""",
                (tenant,project_id)).fetchall()
            previous="0"*64
            for ix,event in enumerate(entries,1):
                payload={"tenant":event["tenant"],"project_id":event["project_id"],
                         "version":event["version"],"stage":event["stage"],
                         "actor":event["actor"],"content_digest":event["content_digest"],
                         "prev_hash":event["prev_hash"],"at_epoch":event["at_epoch"]}
                if (event["version"]!=ix or event["prev_hash"]!=previous
                        or event["event_hash"]!=digest(payload)):
                    raise WorkflowDenied("Tampered or missing workflow event")
                previous=event["event_hash"]
            if len(entries)!=state["version"] or previous!=state["head_hash"] or (
                    entries and entries[-1]["stage"]!=state["stage"]):
                raise WorkflowDenied("Workflow state does not match its event chain")
            return {"tenant":tenant,"project_id":project_id,"stage":state["stage"],
                    "version":state["version"],"reviewer":state["reviewer"],
                    "chain_verified":True,"head_hash":previous,
                    "independent_acceptance":False,"production_release":False}
        finally:
            db.close()
