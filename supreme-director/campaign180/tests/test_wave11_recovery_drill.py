"""Wave11: repeatable, isolated SQLite data-restore drill and API hardening.

Only author-side regression evidence. Real upstream independence and DR
acceptance remain outstanding.
"""
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from wsgiref.util import setup_testing_defaults

from campaign180.app_runtime import LocalAppRuntime,RULE_SCHEMA
from campaign180.app_policy import AppAccessDenied
from campaign180.recovery_drill import LocalRecoveryDrill,_demo
from campaign180.project_recovery import RecoveryDenied
from campaign180.local_http import LocalConsole

ROOT=Path(__file__).resolve().parents[3]
DEMO=ROOT/"supreme-director/campaign180/examples/demo-site.json"
TENANT="tenant_demo"
PROJECT="0b83c3f2-b4ab-4a6f-a83e-a48cb39b9c6f"
OWNER="owner-abc"
TOKEN="Wave11LocalBearerToken_ABCDEfgh0123456789_"*2
PORT=18891

def key():
    return "wave11-"+uuid.uuid4().hex

class DrillTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path=Path(tmp.name)/"data.sqlite3"
        self.app=LocalAppRuntime(str(self.path))
        self.app.drafts.create(json.loads(DEMO.read_text(encoding="utf-8")),
                               tenant=TENANT)
        self.app.policy.bootstrap_owner(tenant=TENANT,project_id=PROJECT,
                                        actor=OWNER,now=1799971200)
        self.kw={"tenant":TENANT,"project_id":PROJECT,"actor":OWNER}
        self.drill=LocalRecoveryDrill(self.app)

    def fixture(self):
        user=self.app.create_row(**self.kw,model="customers",
            data={"name":"Конфиденциальный клиент"},
            idempotency_key=key())
        self.app.create_row(**self.kw,model="requests",
            data={"summary":"Изолированная проверка","customer":user["row_id"]},
            idempotency_key=key())
        return user

    def test_synthetic_end_to_end_demo_is_two_rows_and_one_link(self):
        result=_demo()
        self.assertTrue(result["passed"])
        self.assertEqual(result["rows_verified"],2)
        self.assertEqual(result["links_verified"],1)
        self.assertTrue(result["scratch_only"])
        self.assertFalse(result["production_published"])
        self.assertFalse(result["source_database_modified"])
        self.assertFalse(result["independent_acceptance"])

    def test_real_source_file_not_modified_and_isolated_clone_verified(self):
        self.fixture()
        source_sha=sha256(self.path.read_bytes()).hexdigest()
        report=self.drill.run(**self.kw)
        after_sha=sha256(self.path.read_bytes()).hexdigest()
        self.assertEqual(source_sha,after_sha,"read-only drill must not write to source")
        self.assertTrue(report["passed"])
        self.assertEqual(report["rows_verified"],2)
        self.assertEqual(report["links_verified"],1)
        self.assertFalse(report["contains_customer_data"])
        self.assertNotIn("Конфиденциальный клиент",json.dumps(report,ensure_ascii=False))
        with self.app.drafts._db() as db:
            self.assertEqual(db.execute("""SELECT COUNT(*) FROM draft_projects
                WHERE tenant=?""",(TENANT,)).fetchone()[0],1)
            self.assertEqual(db.execute("PRAGMA quick_check").fetchone()[0],"ok")

    def test_workflows_and_delegated_memberships_remain_out_of_clone(self):
        self.fixture()
        self.app.policy.add_member(tenant=TENANT,project_id=PROJECT,
            owner_actor=OWNER,member_actor="viewer-abc",role="viewer",now=1799971201)
        rule={"schema":RULE_SCHEMA,"name":"Местный workflow",
              "model":"customers","trigger":"manual",
              "condition":None,"action":{"type":"set_field","field":"name","value":"Изменено"}}
        self.app.add_workflow(**self.kw,rule=rule)
        result=self.drill.run(**self.kw)
        self.assertEqual(result["source_workflows_preserved"],1)
        self.assertEqual(result["clone_workflows"],0)
        self.assertEqual(result["clone_delegated_memberships"],0)
        self.assertEqual(self.app.list_workflows(**self.kw)[0]["rule"]["name"],
                         "Местный workflow")

    def test_corrupted_row_digest_never_gets_false_positive(self):
        user=self.fixture()
        with sqlite3.connect(self.path) as db:
            db.execute("""UPDATE builder_rows SET content_digest=? WHERE tenant=?
                AND project_id=? AND model='customers' AND row_id=?""",
                ("0"*64,TENANT,PROJECT,user["row_id"]))
        with self.assertRaises(RecoveryDenied):
            self.drill.run(**self.kw)

    def test_missing_link_index_prevents_claimed_recovery(self):
        self.fixture()
        with sqlite3.connect(self.path) as db:
            db.execute("DELETE FROM builder_links WHERE tenant=? AND project_id=?",
                       (TENANT,PROJECT))
        with self.assertRaises(RecoveryDenied):
            self.drill.run(**self.kw)

    def test_viewer_denied_and_cannot_learn_archive_size_or_counts(self):
        self.fixture()
        self.app.policy.add_member(tenant=TENANT,project_id=PROJECT,
            owner_actor=OWNER,member_actor="viewer-abc",role="viewer",now=1799971201)
        with self.assertRaises(AppAccessDenied):
            self.drill.run(tenant=TENANT,project_id=PROJECT,actor="viewer-abc")

    def test_wrong_tenant_and_project_denied_without_modifying_source(self):
        self.fixture()
        before=sha256(self.path.read_bytes()).hexdigest()
        for tenant,project in (("tenant_other",PROJECT),
                               (TENANT,str(uuid.uuid4()))):
            with self.subTest(tenant=tenant),self.assertRaises(ValueError):
                self.drill.run(tenant=tenant,project_id=project,actor=OWNER)
        self.assertEqual(sha256(self.path.read_bytes()).hexdigest(),before)


class HttpDrillTests(DrillTests):
    def call(self,path,method="GET",body=None,token=TOKEN,actor=OWNER):
        console=LocalConsole(self.path,tenant=TENANT,project_id=PROJECT,
                             actor=actor,token=TOKEN,port=PORT)
        environ={}
        setup_testing_defaults(environ)
        environ.update({"REQUEST_METHOD":method,"PATH_INFO":path,
                        "HTTP_HOST":"127.0.0.1:"+str(PORT),
                        "REMOTE_ADDR":"127.0.0.1","QUERY_STRING":""})
        if token is not None:
            environ["HTTP_AUTHORIZATION"]="Bearer "+token
        if body is not None:
            wire=json.dumps(body).encode("utf-8")
            environ["CONTENT_LENGTH"]=str(len(wire))
            environ["CONTENT_TYPE"]="application/json"
            environ["wsgi.input"]=BytesIO(wire)
        statuses=[]
        response=b"".join(console(environ,lambda status,headers:statuses.append(status)))
        return statuses[0],json.loads(response)

    def test_protected_recovery_drill_does_not_expose_archive_payload(self):
        self.fixture()
        status,result=self.call("/api/v1/recovery/drill","POST",{})
        self.assertTrue(status.startswith("200"),(status,result))
        self.assertTrue(result["passed"])
        self.assertFalse(result["contains_customer_data"])
        self.assertNotIn("Конфиденциальный клиент",json.dumps(result,ensure_ascii=False))
        status,missing=self.call("/api/v1/recovery/export")
        self.assertTrue(status.startswith("404"),status)
        self.assertEqual(missing["error"],"NOT_FOUND")

    def test_recovery_drill_rejects_unknown_json_and_missing_token(self):
        self.fixture()
        url="/api/v1/recovery/drill"
        status,_=self.call(url,"POST",{"tenant":"tenant_other"})
        self.assertTrue(status.startswith("400"))
        status,_=self.call(url,"POST",{},token=None)
        self.assertTrue(status.startswith("401"))
        status,_=self.call(url,"POST",{},token="incorrect")
        self.assertTrue(status.startswith("401"))

    def test_viewer_http_cannot_run_recovery_drill(self):
        self.fixture()
        self.app.policy.add_member(tenant=TENANT,project_id=PROJECT,
            owner_actor=OWNER,member_actor="viewer-abc",role="viewer",now=1799971201)
        status,data=self.call("/api/v1/recovery/drill","POST",{},actor="viewer-abc")
        self.assertTrue(status.startswith("403"),(status,data))
        self.assertEqual(data["error"],"PERMISSION_DENIED")

if __name__=="__main__":
    unittest.main()
