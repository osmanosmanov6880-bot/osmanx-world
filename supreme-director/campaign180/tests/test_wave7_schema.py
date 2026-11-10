"""Wave7 local no-loss schema evolution and real socket WSGI integration."""
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import uuid
from wsgiref.simple_server import make_server

from campaign180.app_runtime import LocalAppRuntime
from campaign180.app_policy import AppAccessDenied
from campaign180.builder import SiteSpecDenied,render_site
from campaign180.model_editor import LocalModelEditor,ModelMigrationDenied
from campaign180.local_http import LocalConsole
from campaign180.contracts import canonical,digest

REPO=Path(__file__).resolve().parents[3]
DEMO=REPO/"supreme-director/campaign180/examples/demo-site.json"
TENANT="tenant_demo"
PROJECT="0b83c3f2-b4ab-4a6f-a83e-a48cb39b9c6f"
OWNER="owner-abc"
TOKEN="LocalConsoleTestToken-"+("abcABC0123_"*6)

def amount():
    return {"name":"amount","label":"Стоимость","type":"integer","required":False}

class SchemaTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db=Path(tmp.name)/"local.sqlite3"
        self.app=LocalAppRuntime(str(self.db))
        self.app.drafts.create(json.loads(DEMO.read_text(encoding="utf8")),tenant=TENANT)
        self.app.policy.bootstrap_owner(tenant=TENANT,project_id=PROJECT,
                                        actor=OWNER,now=1799971200)
        self.editor=LocalModelEditor(self.app)
        self.context={"tenant":TENANT,"project_id":PROJECT,"actor":OWNER}

    def customer(self,name="Марина"):
        return self.app.create_row(**self.context,model="customers",
            data={"name":name},idempotency_key="wave7-"+uuid.uuid4().hex)

    def rows(self,model="customers"):
        return self.app.list_rows(**self.context,model=model)

    def test_new_model_with_typed_field(self):
        res=self.editor.add_model(**self.context,expected_revision=1,
            model={"name":"orders","label":"Заказы","fields":[
                {"name":"name","label":"Название","type":"text","required":True}]})
        self.assertEqual(res["revision"],2)
        added=self.editor.add_field(**self.context,expected_revision=2,
                                    model="orders",field=amount())
        self.assertEqual(added["revision"],3)
        self.app.create_row(**self.context,model="orders",data={"name":"Заказ 1",
            "amount":100},idempotency_key="wave7-"+uuid.uuid4().hex)
        self.assertEqual(self.rows("orders")[0]["fields"]["amount"],100)
        self.assertEqual(len(self.editor.list_migrations(**self.context)),2)

    def test_nullable_addition_preserves_records(self):
        row=self.customer()
        update=self.editor.add_field(**self.context,expected_revision=1,
                                     model="customers",field=amount())
        self.assertEqual(update["rows_migrated"],0)
        self.assertEqual(self.rows()[0]["version"],row["version"])
        self.assertNotIn("amount",self.rows()[0]["fields"])

    def test_required_default_migrates_two_rows_atomically(self):
        self.customer("А")
        self.customer("Б")
        f={"name":"score","label":"Оценка","type":"integer","required":True}
        result=self.editor.add_field(**self.context,expected_revision=1,
            model="customers",field=f,default_provided=True,default_value=7)
        self.assertEqual(result["rows_migrated"],2)
        self.assertEqual([r["version"] for r in self.rows()],[2,2])
        self.assertEqual([r["fields"]["score"] for r in self.rows()],[7,7])
        self.assertEqual(self.editor.list_migrations(**self.context)[0]["rows_migrated"],2)

    def test_required_without_default_fails_without_changes(self):
        old=self.customer()
        with self.assertRaises(ModelMigrationDenied):
            self.editor.add_field(**self.context,expected_revision=1,
                model="customers",field={"name":"code","label":"Код",
                "type":"text","required":True})
        self.assertEqual(self.app.get_spec(**self.context)["revision"],1)
        self.assertEqual(self.rows()[0]["version"],old["version"])

    def test_invalid_default_and_reference_default_fail_closed(self):
        self.customer()
        with self.assertRaises(SiteSpecDenied):
            self.editor.add_field(**self.context,expected_revision=1,
                model="customers",field=amount(),default_provided=True,
                default_value="wrong")
        with self.assertRaises(ModelMigrationDenied):
            self.editor.add_field(**self.context,expected_revision=1,
                model="customers",field={"name":"ref","label":"Связь",
                "type":"reference","references":"customers","required":False},
                default_provided=True,default_value=str(uuid.uuid4()))
        self.assertEqual(self.app.get_spec(**self.context)["revision"],1)

    def test_safe_model_and_field_labels_preserve_rows(self):
        self.customer()
        self.editor.label_model(**self.context,expected_revision=1,model="customers",
                                label="Покупатели")
        self.editor.label_field(**self.context,expected_revision=2,model="customers",
                                field="name",label="ФИО")
        spec=self.app.get_spec(**self.context)["spec"]
        self.assertEqual(spec["models"][0]["label"],"Покупатели")
        self.assertEqual(spec["models"][0]["fields"][0]["label"],"ФИО")
        self.assertEqual(self.rows()[0]["fields"]["name"],"Марина")

    def test_conflicts_and_reserved_names_denied(self):
        with self.assertRaises(SiteSpecDenied):
            self.editor.add_field(**self.context,expected_revision=1,
                model="customers",field={"name":"api_key","label":"Ключ",
                "type":"text","required":False})
        self.editor.label_model(**self.context,expected_revision=1,
                                model="customers",label="Изменён")
        with self.assertRaises(ModelMigrationDenied):
            self.editor.label_model(**self.context,expected_revision=1,
                                    model="customers",label="Устаревшее")

    def test_concurrent_cas_one_writer(self):
        def change(i):
            try:
                self.editor.label_model(**self.context,expected_revision=1,
                                        model="customers",label="V"+str(i))
                return 1
            except ModelMigrationDenied:
                return 0
        with ThreadPoolExecutor(max_workers=6) as pool:
            results=list(pool.map(change,range(6)))
        self.assertEqual(sum(results),1)

    def test_viewer_and_other_tenant_denied(self):
        self.app.policy.add_member(tenant=TENANT,project_id=PROJECT,
            owner_actor=OWNER,member_actor="viewer-abc",role="viewer",now=1799971201)
        with self.assertRaises(AppAccessDenied):
            self.editor.add_field(tenant=TENANT,project_id=PROJECT,
                actor="viewer-abc",expected_revision=1,model="customers",field=amount())
        with self.assertRaises((AppAccessDenied,ValueError)):
            self.editor.add_field(tenant="tenant_other",project_id=PROJECT,
                actor=OWNER,expected_revision=1,model="customers",field=amount())

    def test_receipt_immutable(self):
        self.editor.label_model(**self.context,expected_revision=1,
                                model="customers",label="Клиенты 2")
        with self.assertRaises(sqlite3.IntegrityError):
            with sqlite3.connect(self.db) as con:
                con.execute("DELETE FROM builder_model_migrations")

    def test_row_cap_rejects_migration_before_any_write(self):
        self.customer()
        with sqlite3.connect(self.db) as con:
            for _ in range(500):
                data={"name":"Марина"}
                con.execute("""INSERT INTO builder_rows
                   (tenant,project_id,model,row_id,version,content_digest,data_json,deleted)
                   VALUES(?,?,?,?,?,?,?,0)""",
                   (TENANT,PROJECT,"customers",str(uuid.uuid4()),1,
                    digest(data),canonical(data).decode()))
        with self.assertRaises(ModelMigrationDenied):
            self.editor.add_field(**self.context,expected_revision=1,
                model="customers",field=amount(),default_provided=True,
                default_value=0)
        self.assertEqual(self.app.get_spec(**self.context)["revision"],1)

    def test_static_form_has_disabled_controls_and_no_form_post(self):
        raw=self.app.get_spec(**self.context)["spec"]
        raw["pages"][0]["sections"].append({"type":"form","heading":"Заявка",
                                           "model":"customers","button_label":"Отправить"})
        rendered=render_site(raw)["index.html"].decode()
        self.assertIn("demo-form",rendered)
        self.assertIn('type="button" disabled',rendered)
        self.assertIn('form-action &#39;none&#39;',rendered)
        self.assertNotIn("<script",rendered)

    def test_form_rejects_unknown_model(self):
        raw=self.app.get_spec(**self.context)["spec"]
        raw["pages"][0]["sections"].append({"type":"form","heading":"Заявка",
                                            "model":"unknown"})
        with self.assertRaises(SiteSpecDenied):
            render_site(raw)

    def test_real_socket_post_regression(self):
        console=LocalConsole(self.db,tenant=TENANT,project_id=PROJECT,
                             actor=OWNER,token=TOKEN,port=18767)
        server=make_server("127.0.0.1",0,console)
        console.port=server.server_port
        worker=threading.Thread(target=server.serve_forever,daemon=True)
        worker.start()
        self.addCleanup(lambda:(server.shutdown(),worker.join(timeout=3),
                                server.server_close()))
        connection=http.client.HTTPConnection("127.0.0.1",server.server_port,timeout=3)
        self.addCleanup(connection.close)
        payload=json.dumps({"expected_revision":1,"model":{
            "name":"vendors","label":"Поставщики",
            "fields":[{"name":"name","label":"Название","type":"text","required":True}]}})
        connection.request("POST","/api/v1/schema/models",body=payload.encode(),
            headers={"Host":"127.0.0.1:"+str(server.server_port),
                "Authorization":"Bearer "+TOKEN,"Content-Type":"application/json"})
        response=connection.getresponse()
        self.assertEqual(response.status,201)
        result=json.loads(response.read())
        self.assertEqual(result["revision"],2)
        self.assertEqual(self.app.get_spec(**self.context)["revision"],2)


if __name__=="__main__":
    unittest.main()
