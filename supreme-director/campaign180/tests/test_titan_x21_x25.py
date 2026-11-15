"""Original TITAN-X21-X25: authorized local functionality and negative tests."""
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from wsgiref.util import setup_testing_defaults

from campaign180.app_runtime import LocalAppRuntime, RULE_SCHEMA
from campaign180.app_policy import AppAccessDenied
from campaign180.local_http import LocalConsole
from campaign180.visual_builder import LocalVisualBuilder, VisualDenied

ROOT=Path(__file__).resolve().parents[3]
TENANT="tenant_demo"
OWNER="owner-abc"
EDITOR="editor-abc"
VIEWER="viewer-abc"
PORT=18761
TOKEN="XyZ0987654321_QwErTyUiOpAsDfGhJkLzXcVbNm0123456789"

def key(): return "form-"+uuid.uuid4().hex
def rule(value): return {
    "schema":RULE_SCHEMA,"name":"Local update","model":"customers",
    "trigger":"manual","condition":None,
    "action":{"type":"set_field","field":"email","value":value}
}

class VisualTests(unittest.TestCase):
    def setUp(self):
        t=tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.db=Path(t.name)/"app.db"
        self.spec=json.loads((ROOT/"supreme-director/campaign180/examples/demo-site.json").read_text("utf-8"))
        self.spec["pages"][2]["sections"].append({"type":"form",
            "heading":"Оставить обращение","model":"customers",
            "fields":["name","email"],"button_label":"Добавить"})
        self.pid=self.spec["project_id"]
        self.runtime=LocalAppRuntime(str(self.db))
        self.runtime.drafts.create(self.spec,tenant=TENANT)
        self.runtime.policy.bootstrap_owner(tenant=TENANT,
            project_id=self.pid,actor=OWNER,now=1799971200)
        self.visual=LocalVisualBuilder(self.runtime)

    def ctx(self,actor=OWNER):
        return {"tenant":TENANT,"project_id":self.pid,"actor":actor}

    def form(self,**changes):
        a=dict(self.ctx(),slug="contact",section_index=2,
               expected_revision=1,data={"name":"Ася"},idempotency_key=key())
        a.update(changes)
        return self.visual.submit_form(**a)

    def customer(self):
        return self.runtime.create_row(**self.ctx(),model="customers",
            data={"name":"Test"},idempotency_key=key())

    def test_x21_form_atomic_idempotent_record(self):
        idem=key()
        first=self.form(idempotency_key=idem)
        self.assertEqual(first,self.form(idempotency_key=idem))
        self.assertEqual(first["form_revision"],1)
        self.assertFalse(first["production_visible"])
        self.assertEqual(len(self.runtime.list_rows(**self.ctx(),model="customers")),1)

    def test_x21_hidden_stale_nonform_and_wrong_tenant_denied(self):
        for bad in ({"data":{"name":"A","hidden":"X"}},
                    {"expected_revision":2},{"section_index":1},{"slug":"absent"},
                    {"tenant":"tenant_other"}):
            with self.subTest(bad=bad),self.assertRaises(ValueError):
                self.form(**bad)
        self.assertEqual(self.runtime.list_rows(**self.ctx(),model="customers"),[])

    def test_x21_role_and_collision_denied(self):
        self.runtime.policy.add_member(tenant=TENANT,project_id=self.pid,
            owner_actor=OWNER,member_actor=VIEWER,role="viewer",now=1799971201)
        with self.assertRaises(AppAccessDenied):
            self.form(actor=VIEWER)
        idem=key()
        self.form(idempotency_key=idem)
        with self.assertRaises(ValueError):
            self.form(idempotency_key=idem,data={"name":"Different"})
        self.assertEqual(len(self.runtime.list_rows(**self.ctx(),model="customers")),1)

    def test_x21_concurrent_same_idempotency_key_one_row(self):
        idem=key()
        def call(_):return self.form(idempotency_key=idem)["row_id"]
        with ThreadPoolExecutor(max_workers=4) as pool:
            results=list(pool.map(call,range(8)))
        self.assertEqual(len(set(results)),1)
        self.assertEqual(len(self.runtime.list_rows(**self.ctx(),model="customers")),1)

    def test_x21_reference_field_creates_consistent_link(self):
        self.runtime.edit_structure(**self.ctx(),slug="data",expected_revision=1,
            operation="add",index=3,section={"type":"form","heading":"Request",
            "model":"requests","fields":["customer","summary"]})
        cust=self.customer()
        row=self.visual.submit_form(**self.ctx(),slug="data",section_index=3,
            expected_revision=2,data={"customer":cust["row_id"],"summary":"Quote"},
            idempotency_key=key())
        with self.runtime.drafts._db() as db:
            count=db.execute("""SELECT COUNT(*) FROM builder_links
                WHERE tenant=? AND project_id=? AND model='requests' AND row_id=?""",
                (TENANT,self.pid,row["row_id"])).fetchone()[0]
        self.assertEqual(count,1)

    def test_x22_inspection_is_readonly(self):
        cust=self.customer()
        wf=self.runtime.add_workflow(**self.ctx(),rule=rule("one@example.org"))
        result=self.visual.inspect_workflow(**self.ctx(),
            workflow_id=wf["workflow_id"],row_id=cust["row_id"])
        self.assertTrue(result["would_change"])
        self.assertEqual(result["writes"],0)
        self.assertRegex(result["inspection_sha256"],r"^[0-9a-f]{64}$")
        self.assertEqual(self.runtime.list_rows(**self.ctx(),model="customers")[0]["version"],1)
        with self.runtime.drafts._db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM app_workflow_runs").fetchone()[0],0)

    def test_x22_rule_replacement_audit_and_event_fencing(self):
        cust=self.customer()
        wf=self.runtime.add_workflow(**self.ctx(),rule=rule("old@example.org"))
        event_id=str(uuid.uuid4())
        self.runtime.run_workflow(**self.ctx(),workflow_id=wf["workflow_id"],
            event_id=event_id,trigger="manual",row_id=cust["row_id"])
        out=self.visual.replace_workflow(**self.ctx(),workflow_id=wf["workflow_id"],
            expected_revision=1,rule=rule("new@example.org"))
        self.assertEqual(out["revision"],2)
        with self.assertRaises(ValueError):
            self.visual.replace_workflow(**self.ctx(),workflow_id=wf["workflow_id"],
                expected_revision=1,rule=rule("third@example.org"))
        with self.assertRaises(ValueError):
            self.runtime.run_workflow(**self.ctx(),workflow_id=wf["workflow_id"],
                event_id=event_id,trigger="manual",row_id=cust["row_id"])
        with self.runtime.drafts._db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM app_workflow_rule_changes").fetchone()[0],1)
            with self.assertRaises(Exception):
                db.execute("DELETE FROM app_workflow_rule_changes")

    def test_x22_edit_does_not_enable_disabled_workflow(self):
        wf=self.runtime.add_workflow(**self.ctx(),rule=rule("old@example.org"))
        self.runtime.disable_workflow(**self.ctx(),workflow_id=wf["workflow_id"],
                                       expected_revision=1)
        out=self.visual.replace_workflow(**self.ctx(),workflow_id=wf["workflow_id"],
            expected_revision=2,rule=rule("new@example.org"))
        self.assertFalse(out["enabled"])

    def test_x23_owner_only_member_inventory_includes_revoked(self):
        self.runtime.policy.add_member(tenant=TENANT,project_id=self.pid,
            owner_actor=OWNER,member_actor=EDITOR,role="editor",now=1799971201)
        self.runtime.policy.revoke_member(tenant=TENANT,project_id=self.pid,
            owner_actor=OWNER,member_actor=EDITOR,now=1799971202)
        m=self.visual.list_members(**self.ctx())["members"]
        self.assertEqual({x["actor"] for x in m},{OWNER,EDITOR})
        self.assertFalse(next(x for x in m if x["actor"]==EDITOR)["active"])
        with self.assertRaises(AppAccessDenied):
            self.visual.list_members(**self.ctx(EDITOR))

    def test_x24_diff_history_rejects_stale_and_missing(self):
        self.runtime.edit_page(**self.ctx(),slug="home",expected_revision=1,
                               title="Новая версия")
        diff=self.visual.compare_revisions(**self.ctx(),
            expected_revision=2,target_revision=1)
        self.assertEqual(diff["summary"]["modified_pages"],["home"])
        self.assertFalse(diff["records_included"])
        self.assertNotEqual(diff["current_sha256"],diff["target_sha256"])
        with self.assertRaises(VisualDenied):
            self.visual.compare_revisions(**self.ctx(),
                expected_revision=1,target_revision=1)
        with self.assertRaises(VisualDenied):
            self.visual.compare_revisions(**self.ctx(),
                expected_revision=2,target_revision=3)

    def test_x25_staging_integrity_and_no_deploy(self):
        one=self.visual.inspect_staging(**self.ctx(),expected_revision=1)
        two=self.visual.inspect_staging(**self.ctx(),expected_revision=1)
        self.assertEqual(one,two)
        self.assertTrue(one["integrity_verified"])
        self.assertFalse(one["production_published"])
        self.assertFalse(one["independent_approval"])
        self.runtime.edit_page(**self.ctx(),slug="home",
            expected_revision=1,title="Now changed")
        with self.assertRaises(VisualDenied):
            self.visual.inspect_staging(**self.ctx(),expected_revision=1)

    def _request(self,method,path,body=None,token=TOKEN):
        console=LocalConsole(self.db,tenant=TENANT,project_id=self.pid,
            actor=OWNER,token=TOKEN,port=PORT)
        raw=json.dumps(body).encode("utf-8") if body is not None else b""
        env={}
        setup_testing_defaults(env)
        env.update({"REQUEST_METHOD":method,"PATH_INFO":path,
            "HTTP_HOST":f"127.0.0.1:{PORT}","REMOTE_ADDR":"127.0.0.1",
            "HTTP_AUTHORIZATION":"Bearer "+token,"CONTENT_LENGTH":str(len(raw)),
            "CONTENT_TYPE":"application/json","wsgi.input":BytesIO(raw)})
        status=[]
        response=b"".join(console(env,lambda code,headers:status.append(code)))
        return status[0],json.loads(response)

    def test_x21_x25_real_wsgi_routes_and_auth(self):
        body={"slug":"contact","section_index":2,"expected_revision":1,
              "data":{"name":"HTTP"},"idempotency_key":key()}
        status,created=self._request("POST","/api/v1/forms/submit",body)
        self.assertEqual(status,"201 Created")
        self.assertIn("row_id",created)
        self.assertEqual(self._request("POST","/api/v1/forms/submit",
                                       body,token="invalid")[0],"401 Unauthorized")
        status,preview=self._request("POST","/api/v1/staging/inspect",{"expected_revision":1})
        self.assertEqual(status,"200 OK")
        self.assertTrue(preview["integrity_verified"])
        status,diff=self._request("POST","/api/v1/revisions/compare",
                                   {"expected_revision":1,"target_revision":1})
        self.assertEqual(status,"200 OK")
        self.assertEqual(diff["summary"]["modified_pages"],[])
        status,members=self._request("GET","/api/v1/members")
        self.assertEqual(status,"200 OK")
        self.assertEqual(members["members"][0]["role"],"owner")
        self.assertEqual(self._request("POST","/api/v1/staging/inspect",
            {"expected_revision":1,"tenant":"forged"})[0],"400 Bad Request")

if __name__=="__main__":
    unittest.main()
