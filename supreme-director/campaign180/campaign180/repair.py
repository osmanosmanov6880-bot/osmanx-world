"""TITAN-X19: bounded quarantine for invalid local workflow configuration.

Explicit owner/editor approval is required. Never modifies source code,
customer records, executes third-party code or contacts the network.
"""
from __future__ import annotations
from .app_runtime import LocalAppRuntime, AppOperationDenied
from .contracts import digest,canonical

MAX_REPAIRS = 3
MAX_PROJECT_REPAIRS = 12


class RepairDenied(AppOperationDenied):
    pass


class LocalBoundedRepair:
    def __init__(self, runtime: LocalAppRuntime):
        if type(runtime) is not LocalAppRuntime:
            raise RepairDenied("Trusted local runtime required")
        self.runtime = runtime
        with runtime.drafts._db() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS app_workflow_repairs (
                tenant TEXT NOT NULL, project_id TEXT NOT NULL,
                workflow_id TEXT NOT NULL, previous_revision INTEGER NOT NULL,
                previous_sha256 TEXT NOT NULL, recorded_at INTEGER NOT NULL,
                PRIMARY KEY(tenant,project_id,workflow_id,previous_revision));
            CREATE TRIGGER IF NOT EXISTS app_repairs_no_update BEFORE UPDATE
                ON app_workflow_repairs BEGIN
                SELECT RAISE(ABORT,'immutable repair receipt'); END;
            CREATE TRIGGER IF NOT EXISTS app_repairs_no_delete BEFORE DELETE
                ON app_workflow_repairs BEGIN
                SELECT RAISE(ABORT,'immutable repair receipt'); END;
            CREATE TABLE IF NOT EXISTS app_workflow_replacements (
                tenant TEXT NOT NULL,project_id TEXT NOT NULL,
                workflow_id TEXT NOT NULL,previous_revision INTEGER NOT NULL,
                previous_sha256 TEXT NOT NULL,new_sha256 TEXT NOT NULL,
                recorded_at INTEGER NOT NULL,
                PRIMARY KEY(tenant,project_id,workflow_id,previous_revision));
            CREATE TRIGGER IF NOT EXISTS app_workflow_replace_no_update
                BEFORE UPDATE ON app_workflow_replacements BEGIN
                SELECT RAISE(ABORT,'immutable replacement receipt'); END;
            CREATE TRIGGER IF NOT EXISTS app_workflow_replace_no_delete
                BEFORE DELETE ON app_workflow_replacements BEGIN
                SELECT RAISE(ABORT,'immutable replacement receipt'); END;""")

    def _plan(self, db, *, tenant, project_id, actor, limit):
        if type(limit) is not int or not 1 <= limit <= MAX_REPAIRS:
            raise RepairDenied("Repair limit must be between one and three")
        self.runtime._guard(db, tenant, project_id, actor, "workflow.manage")
        spec, _ = self.runtime.drafts._head(db, tenant, project_id)
        rows = db.execute("""SELECT * FROM app_workflows
            WHERE tenant=? AND project_id=? AND enabled=1 ORDER BY workflow_id""",
            (tenant, project_id)).fetchall()
        broken = []
        for row in rows:
            try:
                rule = self.runtime._read_rule(row)["rule"]
                self.runtime._rule(spec, rule)
            except ValueError:
                broken.append({"workflow_id": row["workflow_id"],
                               "revision": row["revision"],
                               "sha256": row["spec_digest"]})
        used=db.execute("""SELECT COUNT(*) FROM app_workflow_repairs
            WHERE tenant=? AND project_id=?""",(tenant,project_id)).fetchone()[0]
        remaining=max(0,MAX_PROJECT_REPAIRS-used)
        if broken and remaining==0:
            raise RepairDenied("Project automatic-repair budget exhausted")
        candidates=broken[:min(limit,remaining)]
        proposal = {"schema":"osgard.original180.bounded-repair/2",
                    "tenant":tenant, "project_id":project_id,
                    "limit":limit,"budget_remaining":remaining,
                    "candidates":candidates}
        return {"proposal":proposal,"sha256":digest(proposal),
                "pending":len(broken),"budget_remaining":remaining,
                "more_pending":len(broken)>len(candidates)}

    def inspect(self, *, tenant, project_id, actor, limit=2):
        with self.runtime.drafts._db() as db:
            return {**self._plan(db, tenant=tenant,project_id=project_id,
                                 actor=actor,limit=limit),
                    "applied":False,"production_published":False}

    def apply(self, *, tenant, project_id, actor, expected_sha256, now, limit=2):
        if (type(now) is not int or now < 0 or
                type(expected_sha256) is not str or len(expected_sha256)!=64 or
                any(c not in "0123456789abcdef" for c in expected_sha256)):
            raise RepairDenied("Exact approved plan hash and trusted time required")
        with self.runtime.drafts._tx() as db:
            found=self._plan(db,tenant=tenant,project_id=project_id,
                             actor=actor,limit=limit)
            if found["sha256"]!=expected_sha256:
                raise RepairDenied("Repair proposal changed; inspect again")
            for row in found["proposal"]["candidates"]:
                changed=db.execute("""UPDATE app_workflows SET enabled=0,
                    revision=revision+1 WHERE tenant=? AND project_id=?
                    AND workflow_id=? AND revision=? AND spec_digest=?
                    AND enabled=1""",
                    (tenant,project_id,row["workflow_id"],row["revision"],
                     row["sha256"])).rowcount
                if changed!=1:
                    raise RepairDenied("Quarantine revision changed")
                db.execute("""INSERT INTO app_workflow_repairs
                    (tenant,project_id,workflow_id,previous_revision,
                     previous_sha256,recorded_at) VALUES(?,?,?,?,?,?)""",
                    (tenant,project_id,row["workflow_id"],row["revision"],
                     row["sha256"],now))
            return {"repaired":len(found["proposal"]["candidates"]),
                    "pending":found["pending"]-len(found["proposal"]["candidates"]),
                    "budget_remaining":found["budget_remaining"]-
                        len(found["proposal"]["candidates"]),
                    "applied":bool(found["proposal"]["candidates"]),
                    "production_published":False,"external_actions":0}


    def inspect_replacement(self,*,tenant,project_id,actor,workflow_id,
                            replacement_rule):
        """X19: preview a safe deterministic fix for a quarantined workflow."""
        with self.runtime.drafts._db() as db:
            self.runtime._guard(db,tenant,project_id,actor,"workflow.manage")
            spec,_=self.runtime.drafts._head(db,tenant,project_id)
            row=db.execute("""SELECT * FROM app_workflows WHERE tenant=?
                AND project_id=? AND workflow_id=?""",
                (tenant,project_id,workflow_id)).fetchone()
            if row is None or row["enabled"]:
                raise RepairDenied("Only a quarantined workflow may be replaced")
            last=db.execute("""SELECT previous_revision,previous_sha256
                FROM app_workflow_repairs WHERE tenant=? AND project_id=?
                AND workflow_id=? ORDER BY previous_revision DESC LIMIT 1""",
                (tenant,project_id,workflow_id)).fetchone()
            if (last is None or last["previous_revision"]+1!=row["revision"]
                or last["previous_sha256"]!=row["spec_digest"]):
                raise RepairDenied("Missing exact quarantine evidence")
            fixed=self.runtime._rule(spec,replacement_rule)
            new_sha=digest(fixed)
            plan={"schema":"osgard.original180.repaired-rule-replacement/1",
                "tenant":tenant,"project_id":project_id,
                "workflow_id":workflow_id,"expected_revision":row["revision"],
                "quarantined_sha256":row["spec_digest"],
                "replacement_sha256":new_sha}
            return {"plan":plan,"sha256":digest(plan),
                    "new_rule":fixed,"applied":False,
                    "production_published":False}

    def apply_replacement(self,*,tenant,project_id,actor,workflow_id,
                          replacement_rule,expected_sha256,now):
        """CAS replacement, full rule validation, and immutable rollback evidence.

        Caller must separately approve the plan hash. No speculative
        automatic re-enabling of damaged rules is permitted.
        """
        if (type(now) is not int or now<0 or type(expected_sha256) is not str or
            len(expected_sha256)!=64 or any(c not in "0123456789abcdef"
                                           for c in expected_sha256)):
            raise RepairDenied("Exact trusted time and proposal SHA256 required")
        with self.runtime.drafts._tx() as db:
            self.runtime._guard(db,tenant,project_id,actor,"workflow.manage")
            spec,_=self.runtime.drafts._head(db,tenant,project_id)
            row=db.execute("""SELECT * FROM app_workflows WHERE tenant=?
                AND project_id=? AND workflow_id=?""",
                (tenant,project_id,workflow_id)).fetchone()
            if row is None or row["enabled"]:
                raise RepairDenied("Workflow is not in quarantine")
            last=db.execute("""SELECT previous_revision,previous_sha256
                FROM app_workflow_repairs WHERE tenant=? AND project_id=?
                AND workflow_id=? ORDER BY previous_revision DESC LIMIT 1""",
                (tenant,project_id,workflow_id)).fetchone()
            if (last is None or last["previous_revision"]+1!=row["revision"]
                or last["previous_sha256"]!=row["spec_digest"]):
                raise RepairDenied("Quarantine revision no longer matches")
            fixed=self.runtime._rule(spec,replacement_rule)
            new_sha=digest(fixed)
            plan={"schema":"osgard.original180.repaired-rule-replacement/1",
                "tenant":tenant,"project_id":project_id,
                "workflow_id":workflow_id,"expected_revision":row["revision"],
                "quarantined_sha256":row["spec_digest"],
                "replacement_sha256":new_sha}
            if digest(plan)!=expected_sha256:
                raise RepairDenied("Replacement plan was modified")
            changed=db.execute("""UPDATE app_workflows
                SET spec_json=?,spec_digest=?,enabled=1,revision=revision+1
                WHERE tenant=? AND project_id=? AND workflow_id=?
                AND revision=? AND enabled=0 AND spec_digest=?""",
                (canonical(fixed).decode("utf-8"),new_sha,tenant,project_id,
                 workflow_id,row["revision"],row["spec_digest"])).rowcount
            if changed!=1:raise RepairDenied("Concurrent repair modification")
            db.execute("""INSERT INTO app_workflow_replacements
                (tenant,project_id,workflow_id,previous_revision,
                 previous_sha256,new_sha256,recorded_at)
                VALUES(?,?,?,?,?,?,?)""",
                (tenant,project_id,workflow_id,row["revision"],
                 row["spec_digest"],new_sha,now))
            return {"workflow_id":workflow_id,"revision":row["revision"]+1,
                    "enabled":True,"sha256":new_sha,"applied":True,
                    "production_published":False,"external_actions":0}
