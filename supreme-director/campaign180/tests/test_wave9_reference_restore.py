"""Wave 9: independent local regression for relation migrations and safe restore.

Tests verify actual SQLite rows, indices, atomic rollback, tenant/project RBAC,
immutable revision history, and token-bound HTTP operations. These tests are
author tests, not an independent upstream product security acceptance.
"""
import json
from io import BytesIO
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from wsgiref.util import setup_testing_defaults

from campaign180.app_runtime import LocalAppRuntime
from campaign180.model_editor import LocalModelEditor,ModelMigrationDenied
from campaign180.revision_restore import LocalRevisionRestorer,RevisionRestoreDenied
from campaign180.local_http import LocalConsole
from campaign180.contracts import canonical,digest

ROOT=Path(__file__).resolve().parents[3]
DEMO=ROOT/"supreme-director/campaign180/examples/demo-site.json"
TENANT="tenant_demo"
PROJECT="0b83c3f2-b4ab-4a6f-a83e-a48cb39b9c6f"
OWNER="owner-abc"
VIEWER="viewer-abc"
TOKEN="ThisIsAnIsolatedLocalTestToken_1234_ABCDEFghijklmnop"
PORT=18881

def key():return "wave9-"+uuid.uuid4().hex


class Wave9(unittest.TestCase):
    def setUp(self):
        t=tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.database=Path(t.name)/"wave9.sqlite3"
        spec=json.loads(DEMO.read_text(encoding="utf-8"))
        self.app=LocalAppRuntime(str(self.database))
        self.app.drafts.create(spec,tenant=TENANT)
        self.app.policy.bootstrap_owner(tenant=TENANT,project_id=PROJECT,
                                        actor=OWNER,now=1799971200)
        self.schema=LocalModelEditor(self.app)
        self.restore=LocalRevisionRestorer(self.app)
        self.kw={"tenant":TENANT,"project_id":PROJECT,"actor":OWNER}

    def customer(self,name="Клиент"):
        return self.app.create_row(**self.kw,model="customers",
            data={"name":name},idempotency_key=key())

    def request(self,customer_id,summary="Запрос"):
        return self.app.create_row(**self.kw,model="requests",
            data={"customer":customer_id,"summary":summary},idempotency_key=key())

    def records(self,model):
        return self.app.list_rows(**self.kw,model=model)

    def test_reference_rename_updates_json_index_and_live_delete_protection(self):
        a,b=self.customer("А"),self.customer("Б")
        x,y=self.request(a["row_id"]),self.request(b["row_id"])
        result=self.schema.rename_reference_field(**self.kw,expected_revision=1,
            model="requests",old_name="customer",new_name="client_ref")
        self.assertEqual(result["revision"],2)
        self.assertEqual(result["rows_migrated"],2)
        self.assertEqual(result["updated_links"],2)
        rows=self.records("requests")
        self.assertEqual({r["fields"]["client_ref"] for r in rows},
                         {a["row_id"],b["row_id"]})
        self.assertTrue(all(r["version"]==2 and "customer" not in r["fields"] for r in rows))
        with self.app.drafts._db() as db:
            links=db.execute("""SELECT field,target_model FROM builder_links
                WHERE tenant=? AND project_id=? AND model='requests'""",
                (TENANT,PROJECT)).fetchall()
        self.assertEqual(len(links),2)
        self.assertEqual({(r["field"],r["target_model"]) for r in links},
                         {("client_ref","customers")})
        with self.assertRaises(ValueError):
            self.app.delete_row(**self.kw,model="customers",row_id=a["row_id"],
                expected_version=1,idempotency_key=key())
        self.assertEqual(self.schema.list_migrations(**self.kw)[0]["operation"],
                         "RENAME_REFERENCE_FIELD")

    def test_form_selected_relation_is_updated_with_relation_rename(self):
        self.app.edit_structure(**self.kw,slug="home",expected_revision=1,
            operation="add",index=1,
            section={"type":"form","heading":"Запросы","model":"requests",
                     "fields":["summary","customer"],"button_label":"Создать"})
        result=self.schema.rename_reference_field(**self.kw,expected_revision=2,
            model="requests",old_name="customer",new_name="client_ref")
        self.assertEqual(result["revision"],3)
        form=self.app.get_spec(**self.kw)["spec"]["pages"][0]["sections"][1]
        self.assertEqual(form["fields"],["summary","client_ref"])

    def test_corrupt_link_index_rolls_back_reference_rename(self):
        a=self.customer()
        req=self.request(a["row_id"])
        with sqlite3.connect(self.database) as db:
            db.execute("""UPDATE builder_links SET target_row_id=?
                WHERE tenant=? AND project_id=? AND model='requests'""",
                (str(uuid.uuid4()),TENANT,PROJECT))
        old=self.records("requests")[0]
        with self.assertRaises(ModelMigrationDenied):
            self.schema.rename_reference_field(**self.kw,expected_revision=1,
                model="requests",old_name="customer",new_name="client_ref")
        self.assertEqual(self.app.get_spec(**self.kw)["revision"],1)
        self.assertEqual(self.records("requests")[0]["version"],old["version"])

    def test_deleted_source_row_keeps_value_but_no_link_edge(self):
        a=self.customer()
        req=self.request(a["row_id"])
        self.app.delete_row(**self.kw,model="requests",row_id=req["row_id"],
                            expected_version=1,idempotency_key=key())
        outcome=self.schema.rename_reference_field(**self.kw,expected_revision=1,
            model="requests",old_name="customer",new_name="client_ref")
        self.assertEqual(outcome["rows_migrated"],1)
        self.assertEqual(outcome["updated_links"],0)
        with self.app.drafts._db() as db:
            stored,row=self.app.records._row(db,TENANT,PROJECT,"requests",
                                             req["row_id"],deleted_allowed=True)
            self.assertEqual(stored["client_ref"],a["row_id"])
            self.assertEqual(row["version"],3)
            self.assertEqual(row["deleted"],1)

    def test_invalid_relation_name_stale_revision_and_wrong_type_denied(self):
        a=self.customer()
        self.request(a["row_id"])
        for name in ("customer","api_key","id","email","../../etc"):
            with self.subTest(name=name),self.assertRaises(ModelMigrationDenied):
                self.schema.rename_reference_field(**self.kw,expected_revision=1,
                    model="requests",old_name="customer",new_name=name)
        with self.assertRaises(ModelMigrationDenied):
            self.schema.rename_reference_field(**self.kw,expected_revision=1,
                model="requests",old_name="summary",new_name="client_ref")
        self.app.edit_page(**self.kw,slug="home",expected_revision=1,title="Новая")
        with self.assertRaises(ModelMigrationDenied):
            self.schema.rename_reference_field(**self.kw,expected_revision=1,
                model="requests",old_name="customer",new_name="client_ref")

    def test_retarget_optional_unused_reference_then_create_real_link(self):
        a=self.customer()
        existing=self.request(a["row_id"])
        self.schema.add_field(**self.kw,expected_revision=1,model="requests",
            field={"name":"assignee","label":"Ответственный",
                   "type":"reference","required":False,"references":"customers"})
        res=self.schema.retarget_unused_reference(**self.kw,expected_revision=2,
            model="requests",field="assignee",new_target_model="requests")
        self.assertEqual(res["revision"],3)
        self.assertEqual(res["rows_migrated"],0)
        with self.assertRaises(ValueError):
            self.app.create_row(**self.kw,model="requests",
                data={"customer":a["row_id"],"summary":"Некорректная связь",
                      "assignee":a["row_id"]},idempotency_key=key())
        child=self.app.create_row(**self.kw,model="requests",
            data={"customer":a["row_id"],"summary":"Тест",
                  "assignee":existing["row_id"]},idempotency_key=key())
        self.assertEqual(self.records("requests")[-1]["fields"]["assignee"],
                         existing["row_id"])

    def test_retarget_live_relation_denied_with_no_mutation(self):
        a=self.customer()
        self.request(a["row_id"])
        with self.assertRaises(ModelMigrationDenied):
            self.schema.retarget_unused_reference(**self.kw,expected_revision=1,
                model="requests",field="customer",new_target_model="requests")
        self.assertEqual(self.app.get_spec(**self.kw)["revision"],1)
        self.assertEqual(self.records("requests")[0]["version"],1)

    def test_user_without_schema_rights_cannot_migrate_relations(self):
        self.app.policy.add_member(tenant=TENANT,project_id=PROJECT,
            owner_actor=OWNER,member_actor=VIEWER,role="viewer",now=1799971201)
        with self.assertRaises(ValueError):
            self.schema.rename_reference_field(tenant=TENANT,project_id=PROJECT,
                actor=VIEWER,expected_revision=1,model="requests",
                old_name="customer",new_name="client_ref")
        with self.assertRaises(ValueError):
            self.schema.retarget_unused_reference(tenant=TENANT,project_id=PROJECT,
                actor=VIEWER,expected_revision=1,model="requests",
                field="customer",new_target_model="requests")

    def test_restore_creates_new_revision_and_keeps_all_record_bytes(self):
        created=self.customer()
        before=self.records("customers")
        self.app.edit_page(**self.kw,slug="home",expected_revision=1,title="Тестовый заголовок")
        self.app.edit_page(**self.kw,slug="home",expected_revision=2,title="Ещё заголовок")
        preview=self.restore.inspect(**self.kw,expected_revision=3,target_revision=1)
        self.assertEqual(preview["plan"]["changed_page_slugs"],["home"])
        self.assertEqual(preview["plan"]["pages_before"],3)
        self.assertTrue(preview["plan"]["models_unchanged"])
        self.assertTrue(preview["plan"]["record_rows_untouched"])
        out=self.restore.restore(**self.kw,expected_revision=3,target_revision=1,
                                 expected_plan_sha256=preview["plan_sha256"])
        self.assertEqual(out["revision"],4)
        self.assertEqual(self.app.get_spec(**self.kw)["spec"]["pages"][0]["title"],"Главная")
        self.assertEqual(self.app.drafts.load(tenant=TENANT,project_id=PROJECT,
            revision=3)["pages"][0]["title"],"Ещё заголовок")
        self.assertEqual(self.records("customers"),before)
        with self.app.drafts._db() as db:
            receipts=db.execute("""SELECT * FROM builder_page_restores WHERE
                tenant=? AND project_id=?""",(TENANT,PROJECT)).fetchall()
            self.assertEqual(len(receipts),1)
            self.assertEqual(receipts[0]["restored_sha256"],out["sha256"])

    def test_restore_refuses_snapshot_with_different_data_models(self):
        self.schema.add_field(**self.kw,model="customers",expected_revision=1,
            field={"name":"level","label":"Уровень",
                   "type":"integer","required":False})
        with self.assertRaises(RevisionRestoreDenied):
            self.restore.inspect(**self.kw,expected_revision=2,target_revision=1)
        self.assertEqual(self.app.get_spec(**self.kw)["revision"],2)

    def test_restore_rejects_stale_or_unapproved_plan(self):
        self.app.edit_page(**self.kw,slug="home",expected_revision=1,title="Изменён")
        plan=self.restore.inspect(**self.kw,expected_revision=2,target_revision=1)
        with self.assertRaises(RevisionRestoreDenied):
            self.restore.restore(**self.kw,expected_revision=2,target_revision=1,
                                 expected_plan_sha256="0"*64)
        self.app.edit_page(**self.kw,slug="home",expected_revision=2,title="Обновлён снова")
        with self.assertRaises(RevisionRestoreDenied):
            self.restore.restore(**self.kw,expected_revision=2,target_revision=1,
                                 expected_plan_sha256=plan["plan_sha256"])
        self.assertEqual(self.app.get_spec(**self.kw)["revision"],3)

    def test_restore_rejects_cross_project_or_viewer(self):
        self.app.policy.add_member(tenant=TENANT,project_id=PROJECT,
            owner_actor=OWNER,member_actor=VIEWER,role="viewer",now=1799971201)
        self.app.edit_page(**self.kw,slug="home",expected_revision=1,title="Изменён")
        with self.assertRaises(ValueError):
            self.restore.inspect(tenant=TENANT,project_id=PROJECT,actor=VIEWER,
                                 expected_revision=2,target_revision=1)
        with self.assertRaises(ValueError):
            self.restore.inspect(tenant="tenant_other",project_id=PROJECT,actor=OWNER,
                                 expected_revision=2,target_revision=1)

    def test_restore_receipt_is_immutable(self):
        self.app.edit_page(**self.kw,slug="home",expected_revision=1,title="Изменён")
        plan=self.restore.inspect(**self.kw,expected_revision=2,target_revision=1)
        self.restore.restore(**self.kw,expected_revision=2,target_revision=1,
                             expected_plan_sha256=plan["plan_sha256"])
        with self.assertRaises(sqlite3.IntegrityError):
            with sqlite3.connect(self.database) as db:
                db.execute("DELETE FROM builder_page_restores")

    def test_restore_target_missing_and_future_denied(self):
        self.app.edit_page(**self.kw,slug="home",expected_revision=1,title="Изменён")
        for version in (0,-1,3,999,True):
            with self.subTest(version=version),self.assertRaises(ValueError):
                self.restore.inspect(**self.kw,expected_revision=2,
                                     target_revision=version)


class APITests(Wave9):
    def request_json(self,path,method="GET",body=None,token=TOKEN):
        console=LocalConsole(self.database,tenant=TENANT,project_id=PROJECT,
                             actor=OWNER,token=TOKEN,port=PORT)
        env={}
        setup_testing_defaults(env)
        env.update({"HTTP_HOST":"127.0.0.1:"+str(PORT),
                    "REMOTE_ADDR":"127.0.0.1","PATH_INFO":path,
                    "REQUEST_METHOD":method,"QUERY_STRING":""})
        if token is not None:env["HTTP_AUTHORIZATION"]="Bearer "+token
        if body is not None:
            encoded=json.dumps(body).encode("utf-8")
            env.update({"CONTENT_LENGTH":str(len(encoded)),
                        "CONTENT_TYPE":"application/json",
                        "wsgi.input":BytesIO(encoded)})
        statuses=[]
        payload=b"".join(console(env,lambda status,headers:statuses.append(status)))
        return statuses[0],json.loads(payload)

    def test_http_reference_migration_and_revision_plan(self):
        owner=self.customer()
        req=self.request(owner["row_id"])
        status,output=self.request_json("/api/v1/schema/models/requests/rename-reference",
            method="POST",body={"expected_revision":1,
                                "old_name":"customer","new_name":"client_ref"})
        self.assertTrue(status.startswith("200"),(status,output))
        self.assertEqual(output["updated_links"],1)
        self.app.edit_page(**self.kw,slug="home",expected_revision=2,title="Изменён")
        status,history=self.request_json("/api/v1/revisions")
        self.assertTrue(status.startswith("200"))
        self.assertEqual(history["revisions"][0]["revision"],3)
        status,plan=self.request_json("/api/v1/revisions/restore/inspect",
            method="POST",body={"expected_revision":3,"target_revision":2})
        self.assertTrue(status.startswith("200"),(status,plan))
        status,out=self.request_json("/api/v1/revisions/restore",
            method="POST",body={"expected_revision":3,"target_revision":2,
                                "expected_plan_sha256":plan["plan_sha256"]})
        self.assertTrue(status.startswith("200"),(status,out))
        self.assertEqual(out["revision"],4)
        self.assertEqual(self.records("requests")[0]["fields"]["client_ref"],owner["row_id"])

    def test_http_rejects_untrusted_tenant_field_and_missing_token(self):
        path="/api/v1/schema/models/requests/rename-reference"
        data={"expected_revision":1,"old_name":"customer","new_name":"client_ref"}
        status,_=self.request_json(path,"POST",data,token=None)
        self.assertTrue(status.startswith("401"))
        status,_=self.request_json(path,"POST",{**data,"tenant":"tenant_other"})
        self.assertTrue(status.startswith("400"))
        self.assertEqual(self.app.get_spec(**self.kw)["revision"],1)

if __name__=="__main__":
    unittest.main()
