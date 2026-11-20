"""Local, evidence-producing restore drill for OSGARD original180 Wave 11.

A SQLite online backup is made into a temporary, isolated directory. The
owner-only recovery snapshot is exported, verified, and imported as a NEW
project inside that temporary copy. The source DB is opened read-only for
SQLite backup; this code never writes a row to it and never calls production.

No secrets, customer rows, raw archive bytes, or temporary clone IDs are
returned by the drill. This tests the local recovery procedure but does
not replace off-site backup, security review, or independent acceptance.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import tempfile
import uuid

from .app_runtime import LocalAppRuntime
from .project_recovery import LocalProjectRecovery,RecoveryDenied
from .records import RecordDenied


class RecoveryDrillDenied(RecoveryDenied):
    pass


class LocalRecoveryDrill:
    def __init__(self,runtime:LocalAppRuntime):
        if type(runtime) is not LocalAppRuntime:
            raise RecoveryDrillDenied("Trusted local app runtime required")
        self.runtime=runtime

    @staticmethod
    def _database_copy(source_path:str,target:Path):
        # Read-only URI reduces risk of accidentally modifying the original
        # database while still allowing SQLite's consistency-preserving backup.
        absolute=Path(source_path).resolve(strict=True)
        source=sqlite3.connect(absolute.as_uri()+"?mode=ro",uri=True,timeout=15)
        try:
            # sqlite3.Connection's ordinary context manager does NOT close
            # the file descriptor; closing() guarantees the snapshot is ready.
            with closing(sqlite3.connect(str(target),timeout=15)) as scratch:
                source.backup(scratch,pages=100,sleep=0.01)
        finally:
            source.close()

    @staticmethod
    def _source_state(db,tenant,project_id):
        """Capture EVERY recognized project-specific SQLite table, not only rows.

        Includes workflow rules/runs, idempotency receipts, audit events and
        immutable schema/migration receipts. The hashes remain local and only
        a metadata count is exposed in the report.
        """
        tables=("draft_projects","draft_revisions","builder_rows",
                "builder_links","builder_idempotency","app_memberships",
                "app_membership_events","app_workflows","app_workflow_runs",
                "builder_model_migrations","builder_reference_remaps",
                "builder_page_restores")
        available={r["name"] for r in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        out={}
        for table in tables:
            if table not in available:
                out[table]="table-not-initialized"
                continue
            # Constant, hard-coded SQL identifiers; no user-controlled table name.
            rows=[tuple(r) for r in db.execute(
                "SELECT * FROM "+table+" WHERE tenant=? AND project_id=? ORDER BY rowid",
                (tenant,project_id)).fetchall()]
            out[table]=sha256(json.dumps(rows,ensure_ascii=False,
                 sort_keys=True,separators=(",",":")).encode("utf-8")).hexdigest()
        return out

    @staticmethod
    def _row_snapshot(db,tenant,project_id):
        return [tuple(row) for row in db.execute("""SELECT model,row_id,
            version,content_digest,data_json,deleted FROM builder_rows
            WHERE tenant=? AND project_id=? ORDER BY model,row_id""",
            (tenant,project_id)).fetchall()]

    @staticmethod
    def _link_snapshot(db,tenant,project_id):
        return [tuple(row) for row in db.execute("""SELECT model,row_id,field,
            target_model,target_row_id FROM builder_links
            WHERE tenant=? AND project_id=? ORDER BY model,row_id,field""",
            (tenant,project_id)).fetchall()]

    def run(self,*,tenant:str,project_id:str,actor:str)->dict:
        """Treat corrupt records as a failed restore, never raw backend errors."""
        try:
            return self._run_isolated(tenant=tenant,project_id=project_id,actor=actor)
        except RecordDenied as exc:
            raise RecoveryDrillDenied("Archived data failed integrity verification") from exc

    def _run_isolated(self,*,tenant:str,project_id:str,actor:str)->dict:
        # Auth is checked *before* opening any copied database. In particular,
        # a viewer cannot obtain an archive-size or customer-count side channel.
        with self.runtime.drafts._db() as db:
            self.runtime._guard(db,tenant,project_id,actor,"members.manage")
        with tempfile.TemporaryDirectory(prefix="osgard-restore-drill-") as temp:
            scratch_path=Path(temp)/"isolated.sqlite3"
            self._database_copy(self.runtime.drafts.path,scratch_path)
            clone_runtime=LocalAppRuntime(str(scratch_path))
            engine=LocalProjectRecovery(clone_runtime)
            with clone_runtime.drafts._db() as db:
                spec,head=clone_runtime.drafts._head(db,tenant,project_id)
                before_state=self._source_state(db,tenant,project_id)
                before_rows=self._row_snapshot(db,tenant,project_id)
                before_links=self._link_snapshot(db,tenant,project_id)
                before_members=[tuple(row) for row in db.execute("""SELECT
                    actor,role,active,revision FROM app_memberships WHERE tenant=?
                    AND project_id=? ORDER BY actor""",
                    (tenant,project_id)).fetchall()]
                before_workflows=db.execute("""SELECT COUNT(*) FROM app_workflows
                    WHERE tenant=? AND project_id=?""",
                    (tenant,project_id)).fetchone()[0]
            original=engine.inspect(tenant=tenant,project_id=project_id,actor=actor)
            payload=engine.export_bytes(tenant=tenant,project_id=project_id,actor=actor)
            expected_hash=sha256(payload).hexdigest()
            if original["bundle_sha256"]!=expected_hash:
                raise RecoveryDrillDenied("Snapshot export does not match inspect digest")
            engine.verify_bytes(payload,expected_sha256=expected_hash)
            scratch_project_id=str(uuid.uuid4())
            applied=engine.restore_to_new_project(payload,tenant=tenant,actor=actor,
                new_project_id=scratch_project_id,
                expected_sha256=expected_hash,now=1799971290)
            with clone_runtime.drafts._db() as db:
                cloned_spec,cloned_head=clone_runtime.drafts._head(
                    db,tenant,scratch_project_id)
                current_source,source_head=clone_runtime.drafts._head(
                    db,tenant,project_id)
                after_state=self._source_state(db,tenant,project_id)
                after_source_rows=self._row_snapshot(db,tenant,project_id)
                after_source_links=self._link_snapshot(db,tenant,project_id)
                cloned_rows=self._row_snapshot(db,tenant,scratch_project_id)
                cloned_links=self._link_snapshot(db,tenant,scratch_project_id)
                after_members=[tuple(row) for row in db.execute("""SELECT
                    actor,role,active,revision FROM app_memberships WHERE tenant=?
                    AND project_id=? ORDER BY actor""",
                    (tenant,project_id)).fetchall()]
                clone_members=[tuple(row) for row in db.execute("""SELECT
                    actor,role,active,revision FROM app_memberships WHERE tenant=?
                    AND project_id=? ORDER BY actor""",
                    (tenant,scratch_project_id)).fetchall()]
                clone_workflows=db.execute("""SELECT COUNT(*) FROM app_workflows
                    WHERE tenant=? AND project_id=?""",
                    (tenant,scratch_project_id)).fetchone()[0]
                clone_idempotency=db.execute("""SELECT COUNT(*) FROM builder_idempotency
                    WHERE tenant=? AND project_id=?""",
                    (tenant,scratch_project_id)).fetchone()[0]
                check=db.execute("PRAGMA quick_check").fetchone()[0]
            if check!="ok":
                raise RecoveryDrillDenied("Isolated SQLite integrity check failed")
            if (before_state!=after_state
                or current_source!=spec or source_head["revision"]!=head["revision"]
                or after_source_rows!=before_rows or after_source_links!=before_links
                or after_members!=before_members or
                self._row_snapshot_to_hash(cloned_rows)!=self._row_snapshot_to_hash(before_rows)
                or cloned_links!=before_links):
                raise RecoveryDrillDenied("Recovery drill produced mismatching source/clone data")
            if (cloned_spec["models"]!=spec["models"] or
                cloned_spec["pages"]!=spec["pages"] or
                cloned_spec["tenant_id"]!=tenant or
                cloned_spec["project_id"]!=scratch_project_id or
                clone_members!=[(actor,"owner",1,1)] or
                clone_workflows!=0 or clone_idempotency!=0):
                raise RecoveryDrillDenied("Recovery imported unauthorized metadata or identities")
            return {"passed":True,"mode":"isolated_sqlite_online_backup",
                    "source_spec_revision":head["revision"],
                    "source_spec_sha256":head["content_digest"],
                    "verified_bundle_sha256":expected_hash,
                    "rows_verified":len(cloned_rows),
                    "links_verified":len(cloned_links),
                    "source_workflows_preserved":before_workflows,
                    "clone_workflows":clone_workflows,
                    "clone_delegated_memberships":0,
                    "scratch_only":True,"production_published":False,
                    "source_database_modified":False,
                    "source_tables_verified":len(before_state),
                    "contains_customer_data":False,
                    "independent_acceptance":False}

    @staticmethod
    def _row_snapshot_to_hash(rows):
        # Deleted flags, optimistic versions and content hashes all have to
        # match. No personal content is returned in the public result.
        return sha256(json.dumps(rows,ensure_ascii=False,sort_keys=True,
                                 separators=(",",":")).encode("utf-8")).hexdigest()


def _demo()->dict:
    from .project_recovery import LocalProjectRecovery
    root=Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="osgard-recovery-demo-") as temp:
        db=Path(temp)/"demo.sqlite3"
        spec=json.loads((root/"examples"/"demo-site.json").read_text(encoding="utf-8"))
        engine=LocalAppRuntime(str(db))
        tenant=spec["tenant_id"]
        project_id=spec["project_id"]
        actor="owner-abc"
        engine.drafts.create(spec,tenant=tenant)
        engine.policy.bootstrap_owner(tenant=tenant,project_id=project_id,
                                      actor=actor,now=1799971200)
        created=engine.create_row(tenant=tenant,project_id=project_id,actor=actor,
            model="customers",data={"name":"Synthetic Owner","email":"synthetic@example.org"},
            idempotency_key="wave11-recovery-demo-customer")
        engine.create_row(tenant=tenant,project_id=project_id,actor=actor,
            model="requests",data={"summary":"Recovery test",
                                   "customer":created["row_id"]},
            idempotency_key="wave11-recovery-demo-request")
        return LocalRecoveryDrill(engine).run(tenant=tenant,project_id=project_id,actor=actor)


def _archived_demo()->dict:
    """Regression: deleted rows must remain restorable after required-field add."""
    from .model_editor import LocalModelEditor
    root=Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="osgard-archive-proof-") as temp:
        db=Path(temp)/"archived.sqlite3"
        spec=json.loads((root/"examples"/"demo-site.json").read_text(encoding="utf-8"))
        engine=LocalAppRuntime(str(db))
        tenant,project_id=spec["tenant_id"],spec["project_id"]
        actor="owner-abc"
        kw={"tenant":tenant,"project_id":project_id,"actor":actor}
        engine.drafts.create(spec,tenant=tenant)
        engine.policy.bootstrap_owner(**kw,now=1799971200)
        active=engine.create_row(**kw,model="customers",
            data={"name":"Synthetic Active"},idempotency_key="wave12-archived-active")
        archive=engine.create_row(**kw,model="customers",
            data={"name":"Synthetic Archived"},idempotency_key="wave12-archived-row")
        engine.create_row(**kw,model="requests",
            data={"summary":"Retained active relation","customer":active["row_id"]},
            idempotency_key="wave12-archived-link")
        engine.delete_row(**kw,model="customers",row_id=archive["row_id"],
                          expected_version=1,idempotency_key="wave12-archived-delete")
        edit=LocalModelEditor(engine)
        change=edit.add_field(**kw,model="customers",expected_revision=1,
            field={"name":"tier","label":"Tier","type":"integer","required":True},
            default_provided=True,default_value=3)
        if change["rows_migrated"]!=2:
            raise RecoveryDrillDenied("Schema migration failed to include tombstone")
        with engine.drafts._db() as original:
            old,archived=engine.records._row(original,tenant,project_id,
                "customers",archive["row_id"],deleted_allowed=True)
        if archived["deleted"]!=1 or archived["version"]!=3 or old["tier"]!=3:
            raise RecoveryDrillDenied("Archived record lost or not migrated")
        return LocalRecoveryDrill(engine).run(**kw)


def main():
    parser=argparse.ArgumentParser(description="No-network synthetic recovery drill")
    parser.add_argument("mode",choices=("demo","archived"),
                        help="Run isolated active or archived synthetic fixture")
    args=parser.parse_args()
    report=_archived_demo() if args.mode=="archived" else _demo()
    expected_rows=3 if args.mode=="archived" else 2
    if not report["passed"] or report["rows_verified"]!=expected_rows or report["links_verified"]!=1:
        raise SystemExit("DRILL_FAIL")
    print("OSGARD_LOCAL_RESTORE_DRILL_PASS "+json.dumps(report,sort_keys=True))


if __name__=="__main__":
    main()
