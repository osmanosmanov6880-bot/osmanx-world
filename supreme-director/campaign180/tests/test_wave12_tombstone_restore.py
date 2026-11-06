"""Wave 12: regression proofs for tombstone-safe schema changes and restore QA.

These tests exercise the actual local SQLite code. They do not constitute
independent review of canonical upstream products or production readiness.
"""
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid

from campaign180.app_runtime import LocalAppRuntime,RULE_SCHEMA
from campaign180.model_editor import LocalModelEditor,ModelMigrationDenied
from campaign180.project_recovery import LocalProjectRecovery,RecoveryDenied
from campaign180.recovery_drill import LocalRecoveryDrill,RecoveryDrillDenied
from campaign180.contracts import canonical,digest

ROOT=Path(__file__).resolve().parents[3]
SPEC_FILE=ROOT/"supreme-director/campaign180/examples/demo-site.json"
TENANT="tenant_demo"
PROJECT="0b83c3f2-b4ab-4a6f-a83e-a48cb39b9c6f"
ACTOR="owner-abc"

def idem():
    return "wave12-"+uuid.uuid4().hex

def required(name="level"):
    return {"name":name,"label":"Уровень","type":"integer","required":True}

class ArchivedSchemaMigrationTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path=Path(temp.name)/"wave12.sqlite3"
        self.app=LocalAppRuntime(str(self.path))
        source=json.loads(SPEC_FILE.read_text(encoding="utf-8"))
        self.app.drafts.create(source,tenant=TENANT)
        self.app.policy.bootstrap_owner(tenant=TENANT,project_id=PROJECT,
                                        actor=ACTOR,now=1799971200)
        self.editor=LocalModelEditor(self.app)
        self.recovery=LocalProjectRecovery(self.app)
        self.drill=LocalRecoveryDrill(self.app)
        self.kw={"tenant":TENANT,"project_id":PROJECT,"actor":ACTOR}

    def customer(self,name="Архивный клиент"):
        return self.app.create_row(**self.kw,model="customers",
            data={"name":name},idempotency_key=idem())

    def tombstone(self,name="Архивный клиент"):
        created=self.customer(name)
        self.app.delete_row(**self.kw,model="customers",
            row_id=created["row_id"],expected_version=1,idempotency_key=idem())
        return created["row_id"]

    def archived(self,row_id):
        with self.app.drafts._db() as db:
            return self.app.records._row(db,TENANT,PROJECT,"customers",
                                          row_id,deleted_allowed=True)

    def test_required_field_migrates_archived_and_active_rows(self):
        archived_id=self.tombstone()
        active=self.customer("Живой клиент")
        result=self.editor.add_field(**self.kw,expected_revision=1,
            model="customers",field=required(),default_provided=True,
            default_value=11)
        self.assertEqual(result["rows_migrated"],2)
        self.assertEqual(result["revision"],2)
        body,head=self.archived(archived_id)
        self.assertEqual(body["level"],11)
        self.assertEqual(head["deleted"],1)
        self.assertEqual(head["version"],3)
        self.assertEqual(self.app.list_rows(**self.kw,model="customers")[0]
                         ["fields"]["level"],11)
        exported=self.recovery.export_bytes(**self.kw)
        self.recovery.verify_bytes(exported,expected_sha256=sha256(exported).hexdigest())
        report=self.drill.run(**self.kw)
        self.assertTrue(report["passed"])
        self.assertEqual(report["rows_verified"],2)
        self.assertEqual(report["source_tables_verified"],12)

    def test_required_field_with_only_tombstones_requires_a_default(self):
        archived_id=self.tombstone()
        with self.assertRaises(ModelMigrationDenied):
            self.editor.add_field(**self.kw,expected_revision=1,
                model="customers",field=required())
        self.assertEqual(self.app.get_spec(**self.kw)["revision"],1)
        body,header=self.archived(archived_id)
        self.assertNotIn("level",body)
        self.assertEqual(header["version"],2)
        self.assertEqual(self.recovery.inspect(**self.kw)["records"],1)

    def test_optional_field_without_default_preserves_tombstone(self):
        old_id=self.tombstone()
        result=self.editor.add_field(**self.kw,expected_revision=1,
            model="customers",field={"name":"nickname","label":"Псевдоним",
                                     "type":"text","required":False})
        self.assertEqual(result["rows_migrated"],0)
        body,head=self.archived(old_id)
        self.assertNotIn("nickname",body)
        self.assertEqual(head["version"],2)
        self.assertEqual(head["deleted"],1)
        self.assertEqual(self.recovery.inspect(**self.kw)["records"],1)

    def test_optional_default_updates_archived_record_and_retains_deleted_bit(self):
        old_id=self.tombstone()
        result=self.editor.add_field(**self.kw,expected_revision=1,
            model="customers",field={"name":"nickname","label":"Псевдоним",
                                     "type":"text","required":False},
            default_provided=True,default_value="Архив")
        self.assertEqual(result["rows_migrated"],1)
        body,head=self.archived(old_id)
        self.assertEqual(body["nickname"],"Архив")
        self.assertEqual(head["version"],3)
        self.assertEqual(head["deleted"],1)
        with self.app.drafts._db() as db:
            self.assertEqual(db.execute("""SELECT COUNT(*) FROM builder_links
                WHERE tenant=? AND project_id=?""",(TENANT,PROJECT)).fetchone()[0],0)

    def test_required_default_failing_validation_rolls_back_archived_rows(self):
        old_id=self.tombstone()
        old=self.archived(old_id)
        with self.assertRaises(ValueError):
            self.editor.add_field(**self.kw,expected_revision=1,
                model="customers",field=required(),default_provided=True,
                default_value="not-an-integer")
        self.assertEqual(self.app.get_spec(**self.kw)["revision"],1)
        self.assertEqual(self.archived(old_id)[0],old[0])
        self.assertEqual(self.archived(old_id)[1]["version"],old[1]["version"])

    def test_500_row_budget_includes_archived_tombstones(self):
        created=self.customer("Единственная активная")
        body={"name":"Архив"}
        with sqlite3.connect(self.path) as db:
            for _ in range(500):
                db.execute("""INSERT INTO builder_rows
                    (tenant,project_id,model,row_id,version,content_digest,data_json,deleted)
                    VALUES(?,?,?,?,2,?,?,1)""",
                    (TENANT,PROJECT,"customers",str(uuid.uuid4()),digest(body),
                     canonical(body).decode("utf-8")))
        with self.assertRaises(ModelMigrationDenied):
            self.editor.add_field(**self.kw,expected_revision=1,
                model="customers",field=required(),default_provided=True,
                default_value=1)
        self.assertEqual(self.app.get_spec(**self.kw)["revision"],1)
        self.assertEqual(self.app.list_rows(**self.kw,model="customers")[0]
                         ["version"],1)

    def test_archived_required_reference_preserves_no_link(self):
        customer=self.customer("Активный")
        request=self.app.create_row(**self.kw,model="requests",
            data={"summary":"История","customer":customer["row_id"]},
            idempotency_key=idem())
        self.app.delete_row(**self.kw,model="requests",
            row_id=request["row_id"],expected_version=1,idempotency_key=idem())
        self.editor.add_field(**self.kw,model="requests",expected_revision=1,
            field={"name":"risk","label":"Риск","type":"integer","required":True},
            default_provided=True,default_value=3)
        archive=self.recovery.export_bytes(**self.kw)
        self.assertTrue(self.recovery.verify_bytes(
            archive,expected_sha256=sha256(archive).hexdigest()))
        result=self.drill.run(**self.kw)
        self.assertTrue(result["passed"])
        self.assertEqual(result["links_verified"],0)
        self.assertEqual(result["rows_verified"],2)

    def test_drill_catches_unexpected_source_workflow_changes_on_copy(self):
        self.customer()
        rules={"schema":RULE_SCHEMA,"name":"Ручное правило",
               "model":"customers","trigger":"manual","condition":None,
               "action":{"type":"set_field","field":"name","value":"Выполнено"}}
        self.app.add_workflow(**self.kw,rule=rules)
        original=LocalProjectRecovery.restore_to_new_project
        def mutate_source_in_scratch(engine,*args,**kwargs):
            result=original(engine,*args,**kwargs)
            with engine.runtime.drafts._db() as db:
                db.execute("""UPDATE app_workflows SET enabled=0
                    WHERE tenant=? AND project_id=?""",(TENANT,PROJECT))
            return result
        with patch.object(LocalProjectRecovery,"restore_to_new_project",
                          new=mutate_source_in_scratch):
            with self.assertRaises(RecoveryDrillDenied):
                self.drill.run(**self.kw)
        # The mutation took place inside a temporary copy, never the source.
        self.assertEqual(self.app.list_workflows(**self.kw)[0]["rule"]["name"],
                         "Ручное правило")

    def test_drill_catches_unexpected_source_idempotency_mutation(self):
        self.customer()
        original=LocalProjectRecovery.restore_to_new_project
        def alter_receipt_on_scratch(engine,*args,**kwargs):
            result=original(engine,*args,**kwargs)
            with engine.runtime.drafts._db() as db:
                db.execute("""DELETE FROM builder_idempotency WHERE tenant=?
                    AND project_id=?""",(TENANT,PROJECT))
            return result
        with patch.object(LocalProjectRecovery,"restore_to_new_project",
                          new=alter_receipt_on_scratch):
            with self.assertRaises(RecoveryDrillDenied):
                self.drill.run(**self.kw)

    def test_verify_clone_does_not_expose_sensitive_personal_fields(self):
        self.customer("Контрольное имя клиента")
        data=self.drill.run(**self.kw)
        text=json.dumps(data,ensure_ascii=False)
        self.assertTrue(data["passed"])
        self.assertNotIn("Контрольное имя клиента",text)
        self.assertNotIn("rows",data)
        self.assertNotIn("fields",data)
        self.assertNotIn("emails",data)
        self.assertEqual(data["source_tables_verified"],12)

if __name__=="__main__":
    unittest.main()
