"""Wave8 real tenant-safe reference choices, form editing and field renames."""
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from wsgiref.util import setup_testing_defaults

from campaign180.app_runtime import LocalAppRuntime,AppOperationDenied,RULE_SCHEMA
from campaign180.app_policy import AppAccessDenied
from campaign180.builder import SiteSpecDenied,render_site
from campaign180.forms import FormEditorDenied
from campaign180.model_editor import LocalModelEditor,ModelMigrationDenied
from campaign180.local_http import LocalConsole
from campaign180.contracts import canonical,digest

ROOT=Path(__file__).resolve().parents[3]
DEMO=ROOT/"supreme-director/campaign180/examples/demo-site.json"
TENANT="tenant_demo"
PROJECT="0b83c3f2-b4ab-4a6f-a83e-a48cb39b9c6f"
OWNER="owner-abc"
VIEWER="viewer-abc"
TOKEN="StrongLocalTestToken_ABC123xyz-"*3
PORT=18941

def key():
    return "wave8-"+uuid.uuid4().hex

class AppTests(unittest.TestCase):
    def setUp(self):
        t=tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.db=Path(t.name)/"wave8.sqlite3"
        self.app=LocalAppRuntime(str(self.db))
        self.app.drafts.create(json.loads(DEMO.read_text(encoding="utf8")),tenant=TENANT)
        self.app.policy.bootstrap_owner(tenant=TENANT,project_id=PROJECT,actor=OWNER,now=1799971200)
        self.editor=LocalModelEditor(self.app)
        self.kw={"tenant":TENANT,"project_id":PROJECT,"actor":OWNER}

    def customer(self,name="Клиент"):
        return self.app.create_row(**self.kw,model="customers",
            data={"name":name,"email":"customer@example.org"},idempotency_key=key())

    def home_form(self,fields=None):
        return self.app.edit_structure(**self.kw,slug="home",expected_revision=1,
            operation="add",index=1,section={"type":"form","heading":"Заявка",
                "model":"customers","button_label":"Создать",
                "fields":fields or ["name","email"]})

    def form(self):
        return self.app.get_spec(**self.kw)["spec"]["pages"][0]["sections"][1]

    def test_choices_only_active_records_with_safe_labels(self):
        a=self.customer("Анна")
        b=self.customer("Борис")
        out=self.app.reference_choices(**self.kw,model="customers")
        self.assertEqual(out["total_included"],2)
        self.assertFalse(out["truncated"])
        self.assertEqual([x["row_id"] for x in out["choices"]],[a["row_id"],b["row_id"]])
        self.assertEqual([x["label"] for x in out["choices"]],["Анна","Борис"])
        self.app.delete_row(**self.kw,model="customers",
            row_id=a["row_id"],expected_version=1,idempotency_key=key())
        after=self.app.reference_choices(**self.kw,model="customers")
        self.assertEqual([x["row_id"] for x in after["choices"]],[b["row_id"]])

    def test_no_cross_tenant_reference_options(self):
        foreign=json.loads(DEMO.read_text(encoding="utf8"))
        foreign["tenant_id"]="tenant_other"
        foreign["project_id"]=str(uuid.uuid4())
        self.app.drafts.create(foreign,tenant="tenant_other")
        self.app.policy.bootstrap_owner(tenant="tenant_other",
            project_id=foreign["project_id"],actor=OWNER,now=1799971201)
        self.app.create_row(tenant="tenant_other",project_id=foreign["project_id"],
            actor=OWNER,model="customers",data={"name":"Чужая запись"},
            idempotency_key=key())
        local=self.customer("Наша запись")
        choices=self.app.reference_choices(**self.kw,model="customers")
        self.assertEqual(choices["total_included"],1)
        self.assertEqual(choices["choices"][0]["row_id"],local["row_id"])
        with self.assertRaises(AppAccessDenied):
            self.app.reference_choices(tenant="tenant_other",project_id=PROJECT,
                actor=OWNER,model="customers")

    def test_reference_integrity_and_clear_optional_reference(self):
        parent=self.customer()
        req=self.app.create_row(**self.kw,model="requests",
            data={"summary":"Связанный запрос","customer":parent["row_id"]},
            idempotency_key=key())
        with self.assertRaises(AppOperationDenied):
            self.app.delete_row(**self.kw,model="customers",
                row_id=parent["row_id"],expected_version=1,idempotency_key=key())
        changed=self.app.update_row(**self.kw,model="requests",
            row_id=req["row_id"],expected_version=1,
            changes={"customer":None},idempotency_key=key())
        self.assertEqual(changed["version"],2)
        self.app.delete_row(**self.kw,model="customers",
            row_id=parent["row_id"],expected_version=1,idempotency_key=key())

    def test_reference_from_another_project_is_denied(self):
        other=json.loads(DEMO.read_text(encoding="utf8"))
        other["project_id"]=str(uuid.uuid4())
        self.app.drafts.create(other,tenant=TENANT)
        self.app.policy.bootstrap_owner(tenant=TENANT,project_id=other["project_id"],
                                        actor=OWNER,now=1799971202)
        foreign=self.app.create_row(tenant=TENANT,project_id=other["project_id"],
            actor=OWNER,model="customers",data={"name":"Другая площадка"},idempotency_key=key())
        with self.assertRaises(AppOperationDenied):
            self.app.create_row(**self.kw,model="requests",
                data={"summary":"Нельзя","customer":foreign["row_id"]},
                idempotency_key=key())

    def test_choices_truncated_and_limit_100(self):
        one={"name":"Локальный"}
        with sqlite3.connect(self.db) as db:
            for _ in range(101):
                db.execute("""INSERT INTO builder_rows
                    (tenant,project_id,model,row_id,version,content_digest,data_json,deleted)
                    VALUES(?,?,?,?,?,?,?,0)""",
                    (TENANT,PROJECT,"customers",str(uuid.uuid4()),1,digest(one),
                     canonical(one).decode("utf8")))
        result=self.app.reference_choices(**self.kw,model="customers")
        self.assertEqual(len(result["choices"]),100)
        self.assertTrue(result["truncated"])

    def test_form_edit_reorders_selected_fields_and_preserves_revisions(self):
        self.home_form()
        updated=self.app.edit_form(**self.kw,slug="home",expected_revision=2,
            section_index=1,model="customers",heading="Форма заявки",
            button_label="Добавить",fields=["email","name"])
        self.assertEqual(updated["revision"],3)
        self.assertEqual(self.form()["fields"],["email","name"])
        self.assertEqual(self.form()["button_label"],"Добавить")
        old=self.app.drafts.load(tenant=TENANT,project_id=PROJECT,revision=2)
        self.assertEqual(old["pages"][0]["sections"][1]["fields"],["name","email"])
        snippet=render_site(self.app.get_spec(**self.kw)["spec"])["index.html"].decode()
        form=snippet.split('<form class="demo-form">')[1].split("</form>")[0]
        self.assertLess(form.index('type="email"'),form.index('type="text"'))
        self.assertIn('type="button" disabled',form)

    def test_form_missing_fields_stale_revision_and_wrong_section_denied(self):
        self.home_form()
        original=self.form()
        for selected in (["missing"],["name","name"],[],["email","missing"]):
            with self.subTest(selected=selected),self.assertRaises(SiteSpecDenied):
                self.app.edit_form(**self.kw,slug="home",expected_revision=2,
                    section_index=1,model="customers",heading="Форма",
                    button_label="Отправить",fields=selected)
        self.assertEqual(self.form(),original)
        self.app.edit_form(**self.kw,slug="home",expected_revision=2,
            section_index=1,model="customers",heading="Форма",
            button_label="Отправить",fields=["name"])
        with self.assertRaises(FormEditorDenied):
            self.app.edit_form(**self.kw,slug="home",expected_revision=2,
                section_index=1,model="customers",heading="Устаревшая",
                button_label="Отправить",fields=["name"])
        with self.assertRaises(FormEditorDenied):
            self.app.edit_form(**self.kw,slug="home",expected_revision=3,
                section_index=0,model="customers",heading="Не форма",
                button_label="Отправить",fields=["name"])

    def test_viewer_cannot_modify_forms_or_schema(self):
        self.home_form()
        self.app.policy.add_member(tenant=TENANT,project_id=PROJECT,
            owner_actor=OWNER,member_actor=VIEWER,role="viewer",now=1799971201)
        with self.assertRaises(AppAccessDenied):
            self.app.edit_form(tenant=TENANT,project_id=PROJECT,actor=VIEWER,
                slug="home",expected_revision=2,section_index=1,
                model="customers",heading="Нет",button_label="Нет",fields=["name"])

    def test_field_rename_keeps_rows_unchanged_except_key_and_version(self):
        a=self.customer("А")
        b=self.customer("Б")
        result=self.editor.rename_field(**self.kw,expected_revision=1,
            model="customers",old_name="name",new_name="full_name")
        self.assertEqual(result["rows_migrated"],2)
        self.assertEqual(result["revision"],2)
        self.assertEqual([r["fields"]["full_name"] for r in self.app.list_rows(
            **self.kw,model="customers")],["А","Б"])
        self.assertTrue(all(r["version"]==2 for r in self.app.list_rows(
            **self.kw,model="customers")))
        self.assertEqual(self.editor.list_migrations(**self.kw)[0]["operation"],"RENAME_FIELD")

    def test_field_rename_updates_selected_form_names(self):
        self.home_form()
        out=self.editor.rename_field(**self.kw,expected_revision=2,
            model="customers",old_name="name",new_name="full_name")
        self.assertEqual(out["revision"],3)
        self.assertEqual(self.form()["fields"],["full_name","email"])
        html=render_site(self.app.get_spec(**self.kw)["spec"])["index.html"].decode()
        self.assertIn('<form class="demo-form">',html)

    def test_rename_rejects_reference_field_and_workflow_dependency(self):
        with self.assertRaises(ModelMigrationDenied):
            self.editor.rename_field(**self.kw,expected_revision=1,
                model="requests",old_name="customer",new_name="client_id")
        rule={"schema":RULE_SCHEMA,"name":"Name rule","model":"customers",
              "trigger":"record.created","condition":None,
              "action":{"type":"set_field","field":"name","value":"Авто"}}
        self.app.add_workflow(**self.kw,rule=rule)
        self.customer()
        with self.assertRaises(ModelMigrationDenied):
            self.editor.rename_field(**self.kw,expected_revision=1,
                model="customers",old_name="name",new_name="full_name")
        self.assertIn("name",self.app.list_rows(**self.kw,model="customers")[0]["fields"])
        self.assertEqual(self.app.get_spec(**self.kw)["revision"],1)

    def test_rename_rejects_invalid_target_and_preserves_original(self):
        self.customer()
        for name in ("api_key","id","Name","name","email","../../etc"):
            with self.subTest(name=name),self.assertRaises(ModelMigrationDenied):
                self.editor.rename_field(**self.kw,expected_revision=1,
                    model="customers",old_name="name",new_name=name)
        self.assertEqual(self.app.get_spec(**self.kw)["revision"],1)

    def test_tombstone_field_rename_remains_integrity_verified(self):
        made=self.customer()
        self.app.delete_row(**self.kw,model="customers",row_id=made["row_id"],
                            expected_version=1,idempotency_key=key())
        out=self.editor.rename_field(**self.kw,expected_revision=1,
            model="customers",old_name="name",new_name="full_name")
        self.assertEqual(out["rows_migrated"],1)
        with self.app.drafts._db() as db:
            body,row=self.app.records._row(db,TENANT,PROJECT,"customers",
                                           made["row_id"],deleted_allowed=True)
            self.assertEqual(body["full_name"],"Клиент")
            self.assertEqual(row["version"],3)
            self.assertEqual(row["deleted"],1)

    def test_rename_corrupt_record_rolls_back_schema(self):
        made=self.customer()
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE builder_rows SET content_digest=? WHERE row_id=?",
                       ("0"*64,made["row_id"]))
        with self.assertRaises(AppOperationDenied):
            self.editor.rename_field(**self.kw,expected_revision=1,
                model="customers",old_name="name",new_name="full_name")
        self.assertEqual(self.app.get_spec(**self.kw)["revision"],1)

    def test_rename_500_plus_records_fails_closed(self):
        self.customer()
        row={"name":"Test"}
        with sqlite3.connect(self.db) as db:
            for _ in range(500):
                db.execute("""INSERT INTO builder_rows
                    (tenant,project_id,model,row_id,version,content_digest,data_json,deleted)
                    VALUES(?,?,?,?,?,?,?,0)""",
                    (TENANT,PROJECT,"customers",str(uuid.uuid4()),1,
                     digest(row),canonical(row).decode()))
        with self.assertRaises(ModelMigrationDenied):
            self.editor.rename_field(**self.kw,expected_revision=1,
                model="customers",old_name="name",new_name="full_name")
        self.assertEqual(self.app.get_spec(**self.kw)["revision"],1)

class APITests(AppTests):
    def request(self,path,method="GET",body=None,actor=OWNER,token=TOKEN):
        app=LocalConsole(self.db,tenant=TENANT,project_id=PROJECT,
                         actor=actor,token=TOKEN,port=PORT)
        env={}
        setup_testing_defaults(env)
        env.update({"HTTP_HOST":"127.0.0.1:"+str(PORT),"REMOTE_ADDR":"127.0.0.1",
                    "PATH_INFO":path,"REQUEST_METHOD":method,"QUERY_STRING":""})
        if token is not None:env["HTTP_AUTHORIZATION"]="Bearer "+token
        if body is not None:
            blob=json.dumps(body).encode("utf8")
            env.update({"CONTENT_LENGTH":str(len(blob)),"CONTENT_TYPE":"application/json",
                        "wsgi.input":BytesIO(blob)})
        statuses=[]
        data=b"".join(app(env,lambda status,headers:statuses.append(status)))
        return statuses[0],json.loads(data)

    def test_http_form_edit_and_record_choices(self):
        parent=self.customer()
        self.home_form()
        status,data=self.request("/api/v1/models/customers/choices")
        self.assertTrue(status.startswith("200"))
        self.assertEqual(data["choices"][0]["row_id"],parent["row_id"])
        status,out=self.request("/api/v1/pages/home/form","PATCH",{
            "expected_revision":2,"section_index":1,"model":"customers",
            "heading":"API form","button_label":"Save","fields":["email"]})
        self.assertTrue(status.startswith("200"))
        self.assertEqual(self.form()["fields"],["email"])

    def test_http_rename_requires_token_and_no_actor_spoof(self):
        self.customer()
        path="/api/v1/schema/models/customers/rename-field"
        payload={"expected_revision":1,"old_name":"name","new_name":"full_name"}
        status,_=self.request(path,"POST",payload,token=None)
        self.assertTrue(status.startswith("401"))
        status,_=self.request(path,"POST",{**payload,"actor":"someone-else"})
        self.assertTrue(status.startswith("400"))
        status,result=self.request(path,"POST",payload)
        self.assertTrue(status.startswith("200"))
        self.assertEqual(result["rows_migrated"],1)

if __name__=="__main__":
    unittest.main()
