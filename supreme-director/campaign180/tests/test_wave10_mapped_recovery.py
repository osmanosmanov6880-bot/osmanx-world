"""Wave 10: live relation ID mapping and separate-project data recovery.

Tests are author-side evidence only; independent upstream acceptance is
still missing. All fixture records stay inside disposable local SQLite files.
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
from campaign180.mapped_relations import LocalMappedReferenceMigration,MappedReferenceDenied
from campaign180.project_recovery import LocalProjectRecovery,RecoveryDenied
from campaign180.local_http import LocalConsole

ROOT=Path(__file__).resolve().parents[3]
DEMO=ROOT/"supreme-director/campaign180/examples/demo-site.json"
TENANT="tenant_demo"
PROJECT="0b83c3f2-b4ab-4a6f-a83e-a48cb39b9c6f"
OWNER="owner-abc"
TOKEN="Wave10OnlyLocalStrongToken_ABC123xyz-"*2
PORT=18886

def key():
    return "wave10-"+uuid.uuid4().hex

class Cases(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.file=Path(tmp.name)/"wave10.sqlite3"
        self.app=LocalAppRuntime(str(self.file))
        self.app.drafts.create(json.loads(DEMO.read_text(encoding="utf-8")),
                               tenant=TENANT)
        self.app.policy.bootstrap_owner(tenant=TENANT,project_id=PROJECT,
                                        actor=OWNER,now=1799971200)
        self.migrator=LocalMappedReferenceMigration(self.app)
        self.recovery=LocalProjectRecovery(self.app)
        self.kw={"tenant":TENANT,"project_id":PROJECT,"actor":OWNER}

    def customer(self,name="Клиент"):
        return self.app.create_row(**self.kw,model="customers",
            data={"name":name},idempotency_key=key())

    def request(self,customer_id,name="Заявка"):
        return self.app.create_row(**self.kw,model="requests",
            data={"customer":customer_id,"summary":name},idempotency_key=key())

    def plan_inputs(self,first,second,old_a,old_b):
        return {**self.kw,"expected_revision":1,"model":"requests",
                "field":"customer","new_target_model":"requests",
                "mapping":[{"from_id":old_a,"to_id":first},
                           {"from_id":old_b,"to_id":second}]}

    def fixture(self):
        c1=self.customer("Анна")
        c2=self.customer("Борис")
        r1=self.request(c1["row_id"],"Заявка 1")
        r2=self.request(c2["row_id"],"Заявка 2")
        options=self.plan_inputs(r2["row_id"],r1["row_id"],
                                 c1["row_id"],c2["row_id"])
        return c1,c2,r1,r2,options

    def test_real_mapping_updates_rows_links_and_schema_once(self):
        c1,c2,r1,r2,params=self.fixture()
        before=self.app.get_spec(**self.kw)["revision"]
        inspect=self.migrator.inspect(**params)
        self.assertEqual(before,1)
        self.assertEqual(inspect["plan"]["changed_rows"],2)
        self.assertEqual(inspect["plan"]["changed_links"],2)
        self.assertFalse(inspect["applied"])
        result=self.migrator.apply(**params,
              expected_plan_sha256=inspect["plan_sha256"])
        self.assertEqual(result["revision"],2)
        self.assertEqual(result["rows_migrated"],2)
        self.assertEqual(result["changed_links"],2)
        spec=self.app.get_spec(**self.kw)["spec"]
        field=next(x for x in spec["models"] if x["name"]=="requests")["fields"][0]
        self.assertEqual(field["references"],"requests")
        rows=self.app.list_rows(**self.kw,model="requests")
        self.assertEqual({r["fields"]["customer"] for r in rows},
                         {r1["row_id"],r2["row_id"]})
        self.assertEqual({r["version"] for r in rows},{2})
        with self.app.drafts._db() as db:
            links=db.execute("""SELECT target_model,target_row_id FROM builder_links
                WHERE tenant=? AND project_id=? AND model='requests'""",
                (TENANT,PROJECT)).fetchall()
            receipt=db.execute("SELECT * FROM builder_reference_remaps").fetchone()
        self.assertEqual({x["target_model"] for x in links},{"requests"})
        self.assertEqual({x["target_row_id"] for x in links},{r1["row_id"],r2["row_id"]})
        self.assertEqual(receipt["mapping_sha256"],inspect["plan"]["mapping_sha256"])
        self.assertEqual(self.app.list_rows(**self.kw,model="customers")[0]["version"],1)

    def test_mapping_plan_detects_stale_record_without_schema_revision_change(self):
        c1,c2,r1,r2,params=self.fixture()
        approval=self.migrator.inspect(**params)
        self.app.update_row(**self.kw,model="requests",row_id=r1["row_id"],
            expected_version=1,changes={"summary":"Изменён"},
            idempotency_key=key())
        with self.assertRaises(MappedReferenceDenied):
            self.migrator.apply(**params,expected_plan_sha256=approval["plan_sha256"])
        self.assertEqual(self.app.get_spec(**self.kw)["revision"],1)
        with self.app.drafts._db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM builder_reference_remaps").fetchone()[0],0)

    def test_incomplete_extra_and_colliding_maps_denied(self):
        c1,c2,r1,r2,params=self.fixture()
        bad=[
            params["mapping"][:1],
            params["mapping"]+[{"from_id":str(uuid.uuid4()),"to_id":str(uuid.uuid4())}],
            [{"from_id":c1["row_id"],"to_id":r1["row_id"]},
             {"from_id":c2["row_id"],"to_id":r1["row_id"]}],
        ]
        for mapping in bad:
            with self.subTest(mapping=mapping),self.assertRaises(ValueError):
                self.migrator.inspect(**{**params,"mapping":mapping})
        self.assertEqual(self.app.get_spec(**self.kw)["revision"],1)

    def test_new_targets_must_exist_in_selected_project_and_model(self):
        c1,c2,r1,r2,params=self.fixture()
        bad=[{"from_id":c1["row_id"],"to_id":c2["row_id"]},
             {"from_id":c2["row_id"],"to_id":r1["row_id"]}]
        with self.assertRaises(ValueError):
            self.migrator.inspect(**{**params,"mapping":bad})
        other=json.loads(DEMO.read_text(encoding="utf-8"))
        other["project_id"]=str(uuid.uuid4())
        self.app.drafts.create(other,tenant=TENANT)
        self.app.policy.bootstrap_owner(tenant=TENANT,project_id=other["project_id"],
                                        actor=OWNER,now=1799971201)
        foreign=self.app.create_row(tenant=TENANT,project_id=other["project_id"],
            actor=OWNER,model="requests",data={"customer":self.app.create_row(
                tenant=TENANT,project_id=other["project_id"],actor=OWNER,
                model="customers",data={"name":"Чужой"},idempotency_key=key())["row_id"],
                "summary":"В другом проекте"},idempotency_key=key())
        cross=[{"from_id":c1["row_id"],"to_id":foreign["row_id"]},
               {"from_id":c2["row_id"],"to_id":r1["row_id"]}]
        with self.assertRaises(ValueError):
            self.migrator.inspect(**{**params,"mapping":cross})

    def test_mapping_detects_corrupted_index_and_rolls_back(self):
        c1,c2,r1,r2,params=self.fixture()
        with sqlite3.connect(self.file) as db:
            db.execute("""UPDATE builder_links SET target_row_id=?
                WHERE tenant=? AND project_id=? AND row_id=? AND field='customer'""",
                (str(uuid.uuid4()),TENANT,PROJECT,r1["row_id"]))
        with self.assertRaises(MappedReferenceDenied):
            self.migrator.inspect(**params)
        self.assertEqual(self.app.get_spec(**self.kw)["revision"],1)

    def test_mapping_rejects_unreviewed_workflow_dependency(self):
        c1,c2,r1,r2,params=self.fixture()
        rule={"schema":RULE_SCHEMA,"name":"Не менять без проверки",
              "model":"requests","trigger":"manual",
              "condition":None,"action":{"type":"set_field","field":"customer",
                           "value":c1["row_id"]}}
        self.app.add_workflow(**self.kw,rule=rule)
        with self.assertRaises(MappedReferenceDenied):
            self.migrator.inspect(**params)

    def test_mapping_deleted_source_record_without_creating_live_edge(self):
        c1=self.customer("А")
        source=self.request(c1["row_id"],"Архив")
        target=self.request(c1["row_id"],"Живой")
        self.app.delete_row(**self.kw,model="requests",row_id=source["row_id"],
                            expected_version=1,idempotency_key=key())
        args={**self.kw,"expected_revision":1,"model":"requests",
              "field":"customer","new_target_model":"requests",
              "mapping":[{"from_id":c1["row_id"],"to_id":target["row_id"]}]}
        plan=self.migrator.inspect(**args)
        self.assertEqual(plan["plan"]["deleted_rows_with_values"],1)
        result=self.migrator.apply(**args,expected_plan_sha256=plan["plan_sha256"])
        self.assertEqual(result["changed_links"],1)
        with self.app.drafts._db() as db:
            value,head=self.app.records._row(db,TENANT,PROJECT,"requests",
                source["row_id"],deleted_allowed=True)
            self.assertTrue(head["deleted"])
            self.assertEqual(value["customer"],target["row_id"])
            self.assertEqual(head["version"],3)

    def test_mapping_permisson_checks_and_wizard_never_guesses(self):
        c1,c2,r1,r2,params=self.fixture()
        result=self.migrator.mapping_options(**self.kw,model="requests",
            field="customer",new_target_model="requests")
        self.assertEqual({r["id"] for r in result["sources"]},{c1["row_id"],c2["row_id"]})
        self.assertEqual({r["id"] for r in result["targets"]},{r1["row_id"],r2["row_id"]})
        self.assertTrue(result["requires_explicit_mapping"])
        self.app.policy.add_member(tenant=TENANT,project_id=PROJECT,
            owner_actor=OWNER,member_actor="viewer-abc",role="viewer",now=1799971201)
        with self.assertRaises(AppAccessDenied):
            self.migrator.inspect(**{**params,"actor":"viewer-abc"})
        with self.assertRaises(AppAccessDenied):
            self.migrator.mapping_options(**{**self.kw,"actor":"viewer-abc"},
                model="requests",field="customer",new_target_model="requests")

    def test_recovery_binds_spec_rows_and_edges_in_canonical_bytes(self):
        c1=self.customer()
        req=self.request(c1["row_id"])
        summary=self.recovery.inspect(**self.kw)
        self.assertEqual(summary["records"],2)
        self.assertEqual(summary["links"],1)
        self.assertFalse(summary["plaintext_exported"])
        blob=self.recovery.export_bytes(**self.kw)
        self.assertEqual(summary["bundle_sha256"],sha256(blob).hexdigest())
        packet=self.recovery.verify_bytes(blob,expected_sha256=summary["bundle_sha256"])
        self.assertEqual(len(packet["rows"]),2)
        self.assertEqual(packet["links"][0]["target_row_id"],c1["row_id"])
        self.assertFalse(packet["includes_roles"])
        self.assertFalse(packet["includes_workflows"])

    def test_restore_snapshot_into_new_project_only_original_unchanged(self):
        a=self.customer()
        request=self.request(a["row_id"])
        original=self.app.list_rows(**self.kw,model="requests")
        payload=self.recovery.export_bytes(**self.kw)
        new_project=str(uuid.uuid4())
        out=self.recovery.restore_to_new_project(payload,
            tenant=TENANT,actor=OWNER,new_project_id=new_project,
            expected_sha256=sha256(payload).hexdigest(),now=1799971210)
        self.assertEqual(out["restored_records"],2)
        self.assertEqual(out["restored_links"],1)
        self.assertEqual(out["restored_workflows"],0)
        clone=self.app.list_rows(tenant=TENANT,project_id=new_project,
                                 actor=OWNER,model="requests")
        self.assertEqual(clone,original)
        self.assertEqual(self.app.list_rows(**self.kw,model="requests"),original)
        self.assertEqual(self.app.list_workflows(tenant=TENANT,project_id=new_project,
                                               actor=OWNER),[])
        with self.app.drafts._db() as db:
            src=db.execute("SELECT COUNT(*) FROM app_memberships WHERE tenant=? AND project_id=?",
                           (TENANT,PROJECT)).fetchone()[0]
            tgt=db.execute("SELECT role,actor FROM app_memberships WHERE tenant=? AND project_id=?",
                           (TENANT,new_project)).fetchall()
        self.assertEqual(src,1)
        self.assertEqual([(r["role"],r["actor"]) for r in tgt],[("owner",OWNER)])
        with self.assertRaises(RecoveryDenied):
            self.recovery.restore_to_new_project(payload,tenant=TENANT,actor=OWNER,
                new_project_id=new_project,expected_sha256=sha256(payload).hexdigest(),
                now=1799971220)

    def test_recovery_rejects_corrupted_json_hash_and_link_index(self):
        c1=self.customer()
        self.request(c1["row_id"])
        blob=self.recovery.export_bytes(**self.kw)
        with self.assertRaises(RecoveryDenied):
            self.recovery.verify_bytes(blob+b" ",expected_sha256=sha256(blob).hexdigest())
        with self.assertRaises(RecoveryDenied):
            self.recovery.verify_bytes(blob,expected_sha256="0"*64)
        with sqlite3.connect(self.file) as db:
            db.execute("DELETE FROM builder_links")
        with self.assertRaises(RecoveryDenied):
            self.recovery.inspect(**self.kw)

    def test_recovery_denies_cross_tenant_clone_and_viewer(self):
        self.customer()
        blob=self.recovery.export_bytes(**self.kw)
        with self.assertRaises(RecoveryDenied):
            self.recovery.restore_to_new_project(blob,tenant="tenant_other",
                actor=OWNER,new_project_id=str(uuid.uuid4()),
                expected_sha256=sha256(blob).hexdigest(),now=1799971220)
        self.app.policy.add_member(tenant=TENANT,project_id=PROJECT,
            owner_actor=OWNER,member_actor="viewer-abc",role="viewer",now=1799971201)
        with self.assertRaises(AppAccessDenied):
            self.recovery.inspect(tenant=TENANT,project_id=PROJECT,actor="viewer-abc")
        with self.assertRaises(AppAccessDenied):
            self.recovery.restore_to_new_project(blob,tenant=TENANT,
                actor="viewer-abc",new_project_id=str(uuid.uuid4()),
                expected_sha256=sha256(blob).hexdigest(),now=1799971220)


class HttpCases(Cases):
    def request_api(self,path,*,body=None,token=TOKEN):
        console=LocalConsole(self.file,tenant=TENANT,project_id=PROJECT,
                             actor=OWNER,token=TOKEN,port=PORT)
        env={}
        setup_testing_defaults(env)
        method="POST" if body is not None else "GET"
        env.update({"HTTP_HOST":"127.0.0.1:"+str(PORT),
                    "REMOTE_ADDR":"127.0.0.1",
                    "PATH_INFO":path,"REQUEST_METHOD":method,"QUERY_STRING":""})
        if token is not None:env["HTTP_AUTHORIZATION"]="Bearer "+token
        if body is not None:
            payload=json.dumps(body).encode("utf-8")
            env.update({"CONTENT_LENGTH":str(len(payload)),
                        "CONTENT_TYPE":"application/json","wsgi.input":BytesIO(payload)})
        result=[]
        data=b"".join(console(env,lambda status,headers:result.append(status)))
        return result[0],json.loads(data)

    def test_http_inspect_apply_and_recovery_summary(self):
        c1,c2,r1,r2,params=self.fixture()
        path="/api/v1/references/map"
        status,choices=self.request_api(path+"/options",body={
            "model":"requests","field":"customer","new_target_model":"requests"})
        self.assertTrue(status.startswith("200"),(status,choices))
        self.assertEqual(len(choices["sources"]),2)
        status,plan=self.request_api(path+"/inspect",body={
            "expected_revision":1,"model":"requests","field":"customer",
            "new_target_model":"requests","mapping":params["mapping"]})
        self.assertTrue(status.startswith("200"),(status,plan))
        status,committed=self.request_api(path+"/apply",body={
            "expected_revision":1,"model":"requests","field":"customer",
            "new_target_model":"requests","mapping":params["mapping"],
            "expected_plan_sha256":plan["plan_sha256"]})
        self.assertTrue(status.startswith("200"),(status,committed))
        self.assertEqual(committed["revision"],2)
        status,rec=self.request_api("/api/v1/recovery/inspect")
        self.assertTrue(status.startswith("200"),(status,rec))
        self.assertEqual(rec["records"],4)
        self.assertEqual(rec["links"],2)
        self.assertFalse(rec["plaintext_exported"])

    def test_http_denies_invalid_sha_and_identity_spoofing(self):
        c1,c2,r1,r2,params=self.fixture()
        status,_=self.request_api("/api/v1/references/map/inspect",
            body={**params,"actor":"other"})
        self.assertTrue(status.startswith("400"))
        status,_=self.request_api("/api/v1/recovery/inspect",token=None)
        self.assertTrue(status.startswith("401"))
        status,_=self.request_api("/api/v1/references/map/apply",body={
            "expected_revision":1,"model":"requests","field":"customer",
            "new_target_model":"requests","mapping":params["mapping"],
            "expected_plan_sha256":"0"*64})
        self.assertTrue(status.startswith("400"))
        self.assertEqual(self.app.get_spec(**self.kw)["revision"],1)


if __name__=="__main__":
    unittest.main()
