"""Wave 6 bounded recovery negative tests."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

from campaign180.app_runtime import LocalAppRuntime, RULE_SCHEMA
from campaign180.app_policy import AppAccessDenied
from campaign180.repair import LocalBoundedRepair, RepairDenied

REPO=Path(__file__).resolve().parents[3]
TENANT="tenant_demo"
PROJECT="0b83c3f2-b4ab-4a6f-a83e-a48cb39b9c6f"
OWNER="owner-abc"


class RepairTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db=Path(tmp.name)/"repair.sqlite3"
        app=LocalAppRuntime(str(self.db))
        raw=json.loads((REPO/"supreme-director/campaign180/examples/demo-site.json")
                       .read_text(encoding="utf-8"))
        app.drafts.create(raw,tenant=TENANT)
        app.policy.bootstrap_owner(tenant=TENANT,project_id=PROJECT,
                                   actor=OWNER,now=1799971200)
        self.app=app
        self.repair=LocalBoundedRepair(app)

    def damage(self,count=1):
        for i in range(count):
            rule={"schema":RULE_SCHEMA,"name":"Repair case "+str(i),
                  "model":"customers","trigger":"record.created",
                  "condition":None,"action":{"type":"set_field","field":"email",
                    "value":"test@example.org"}}
            wf=self.app.add_workflow(tenant=TENANT,project_id=PROJECT,
                actor=OWNER,rule=rule)
            with sqlite3.connect(self.db) as db:
                db.execute("UPDATE app_workflows SET spec_json='{}' WHERE workflow_id=?",
                           (wf["workflow_id"],))

    def inspect(self,limit=2,actor=OWNER):
        return self.repair.inspect(tenant=TENANT,project_id=PROJECT,
                                   actor=actor,limit=limit)

    def apply(self,plan,limit=2,actor=OWNER):
        return self.repair.apply(tenant=TENANT,project_id=PROJECT,
            actor=actor,limit=limit,expected_sha256=plan["sha256"],now=1799971230)

    def test_inspect_does_not_modify_and_apply_quarantines(self):
        self.damage()
        plan=self.inspect()
        self.assertEqual(plan["pending"],1)
        self.assertFalse(plan["applied"])
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT enabled FROM app_workflows").fetchone()[0],1)
        changed=self.apply(plan)
        self.assertEqual(changed["repaired"],1)
        self.assertEqual(changed["pending"],0)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT enabled FROM app_workflows").fetchone()[0],0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM app_workflow_repairs").fetchone()[0],1)
        made=self.app.create_row(tenant=TENANT,project_id=PROJECT,actor=OWNER,
            model="customers",data={"name":"После восстановления"},
            idempotency_key="repair-"+uuid.uuid4().hex)
        self.assertEqual(made["automatic_workflows"]["dispatched"],0)

    def test_repair_limit_three_and_multi_pass(self):
        self.damage(5)
        preview=self.inspect()
        self.assertEqual(len(preview["proposal"]["candidates"]),2)
        self.assertTrue(preview["more_pending"])
        self.assertEqual(self.apply(preview)["pending"],3)
        next_plan=self.inspect(limit=3)
        self.assertEqual(self.apply(next_plan,limit=3)["pending"],0)

    def test_changed_plan_hash_denied(self):
        self.damage()
        preview=self.inspect()
        self.damage()
        with self.assertRaises(RepairDenied):
            self.apply(preview)
        with self.assertRaises(RepairDenied):
            self.repair.apply(tenant=TENANT,project_id=PROJECT,
                              actor=OWNER,expected_sha256="0"*64,
                              limit=2,now=1799971230)

    def test_viewer_denied_and_cross_tenant_denied(self):
        self.app.policy.add_member(tenant=TENANT,project_id=PROJECT,
            owner_actor=OWNER,member_actor="viewer-abc",role="viewer",
            now=1799971201)
        self.damage()
        with self.assertRaises(AppAccessDenied):
            self.inspect(actor="viewer-abc")
        with self.assertRaises(AppAccessDenied):
            self.inspect(actor=OWNER,limit=2) if False else self.repair.inspect(
                tenant="tenant_other",project_id=PROJECT,actor=OWNER,limit=2)

    def test_invalid_limits_fail_closed(self):
        for val in (0,-1,4,True,1.5):
            with self.subTest(limit=val),self.assertRaises(RepairDenied):
                self.inspect(limit=val)

    def test_good_rules_not_disabled(self):
        preview=self.inspect()
        self.assertEqual(preview["pending"],0)
        self.assertFalse(self.apply(preview)["applied"])

    def test_repair_receipt_immutable(self):
        self.damage()
        self.apply(self.inspect())
        with self.assertRaises(sqlite3.IntegrityError):
            with sqlite3.connect(self.db) as db:
                db.execute("DELETE FROM app_workflow_repairs")


if __name__=="__main__":
    unittest.main()
