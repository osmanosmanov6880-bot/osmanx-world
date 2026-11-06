"""Wave 6: actual atomic record events, no-code structure and API adversarial tests."""
import json
from io import BytesIO
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from wsgiref.util import setup_testing_defaults

from campaign180.app_runtime import LocalAppRuntime,AppOperationDenied,RULE_SCHEMA
from campaign180.app_policy import AppAccessDenied
from campaign180.structure import StructureDenied
from campaign180.local_http import LocalConsole

ROOT=Path(__file__).resolve().parents[3]
DEMO=ROOT/"supreme-director/campaign180/examples/demo-site.json"
TENANT="tenant_demo"
OWNER="owner-abc"
VIEWER="viewer-abc"
TOKEN="F5z-LocalDeveloperOnly-Token-"+("aB4_"*18)
PORT=18766

def newkey():
    return "event-"+uuid.uuid4().hex

def rule(event,*,model="customers",field="email",value="automatic@example.org",
         condition=None,name="Workflow"):
    return {"schema":RULE_SCHEMA,"name":name,"model":model,"trigger":event,
            "condition":condition,"action":{"type":"set_field",
                                             "field":field,"value":value}}

class Wave6Setup(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.db=Path(temp.name)/"app.sqlite3"
        spec=json.loads(DEMO.read_text(encoding="utf-8"))
        self.project=spec["project_id"]
        self.app=LocalAppRuntime(str(self.db))
        self.app.drafts.create(spec,tenant=TENANT)
        self.app.policy.bootstrap_owner(tenant=TENANT,project_id=self.project,
                                        actor=OWNER,now=1799971200)
        self.args={"tenant":TENANT,"project_id":self.project,"actor":OWNER}

    def customer(self,name="Марина"):
        return self.app.create_row(**self.args,model="customers",
            data={"name":name},idempotency_key=newkey())

    def get(self,row_id):
        return next(x for x in self.app.list_rows(**self.args,model="customers")
                    if x["row_id"]==row_id)

    def make_rule(self,trigger,**kw):
        return self.app.add_workflow(**self.args,rule=rule(trigger,**kw))


class AutomaticWorkflowTests(Wave6Setup):
    def test_real_record_created_event_in_same_transaction(self):
        self.make_rule("record.created")
        row=self.customer()
        self.assertEqual(row["automatic_workflows"]["dispatched"],1)
        self.assertEqual(row["automatic_workflows"]["changed"],1)
        self.assertEqual(row["version"],2)
        self.assertEqual(self.get(row["row_id"])["fields"]["email"],
                         "automatic@example.org")
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM app_workflow_runs").fetchone()[0],1)

    def test_real_updated_event_and_idempotent_mutation(self):
        self.make_rule("record.updated",field="email",value="updated@example.org")
        customer=self.customer()
        key=newkey()
        kwargs=dict(**self.args,model="customers",row_id=customer["row_id"],
                    expected_version=1,changes={"name":"Новое имя"},
                    idempotency_key=key)
        first=self.app.update_row(**kwargs)
        self.assertEqual(first["version"],3)
        self.assertEqual(first,self.app.update_row(**kwargs))
        self.assertEqual(self.get(customer["row_id"])["version"],3)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM app_workflow_runs").fetchone()[0],1)

    def test_conditional_event_miss_creates_only_run_receipt(self):
        self.make_rule("record.created",condition={"field":"name","equals":"Ада"})
        created=self.customer("Марина")
        self.assertEqual(created["version"],1)
        self.assertEqual(created["automatic_workflows"]["matched"],0)
        self.assertEqual(created["automatic_workflows"]["dispatched"],1)

    def test_disabled_event_never_executes(self):
        workflow=self.make_rule("record.created")
        self.app.disable_workflow(**self.args,workflow_id=workflow["workflow_id"],
                                  expected_revision=1)
        row=self.customer()
        self.assertEqual(row["automatic_workflows"]["dispatched"],0)
        self.assertEqual(row["version"],1)

    def test_two_automatic_rules_bounded_nonrecursive(self):
        self.make_rule("record.created",field="name",value="Новое имя",name="Rename")
        self.make_rule("record.created",field="email",value="second@example.org",
                       name="Attach")
        row=self.customer()
        self.assertEqual(row["automatic_workflows"]["dispatched"],2)
        self.assertEqual(row["version"],3)
        self.assertEqual(self.get(row["row_id"])["fields"]["name"],"Новое имя")
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM app_workflow_runs").fetchone()[0],2)

    def test_client_cannot_forge_event_via_manual_run(self):
        workflow=self.make_rule("record.created")
        row=self.customer()
        with self.assertRaises(AppOperationDenied):
            self.app.run_workflow(**self.args,workflow_id=workflow["workflow_id"],
                event_id=str(uuid.uuid4()),trigger="record.created",
                row_id=row["row_id"])

    def test_corrupt_enabled_rule_rolls_back_entire_record_create(self):
        wf=self.make_rule("record.created")
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE app_workflows SET spec_json='{}' WHERE workflow_id=?",
                       (wf["workflow_id"],))
        with self.assertRaises(AppOperationDenied):
            self.customer("Несохранённая")
        self.assertEqual(self.app.list_rows(**self.args,model="customers"),[])
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM builder_idempotency").fetchone()[0],0)

    def test_revoked_role_does_not_dispatch_side_effect(self):
        self.make_rule("record.created")
        self.app.policy.add_member(**self.args,owner_actor=OWNER,
                                   member_actor=VIEWER,role="operator",now=1799971202)
        self.app.policy.revoke_member(**self.args,owner_actor=OWNER,
                                      member_actor=VIEWER,now=1799971203)
        with self.assertRaises(AppAccessDenied):
            self.app.create_row(tenant=TENANT,project_id=self.project,actor=VIEWER,
                model="customers",data={"name":"Недоступно"},idempotency_key=newkey())
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM app_workflow_runs").fetchone()[0],0)

    def test_insert_then_auto_event_is_visible_in_preview(self):
        self.make_rule("record.created")
        self.customer()
        pages=self.app.render_preview(**self.args)
        self.assertIn("automatic@example.org",pages["data.html"].decode("utf-8"))


class StructureTests(Wave6Setup):
    def test_add_move_remove_produces_three_immutable_revisions(self):
        v1=self.app.get_spec(**self.args)["spec"]
        self.assertEqual(len(v1["pages"][0]["sections"]),3)
        result=self.app.edit_structure(**self.args,slug="home",
            operation="add",index=1,expected_revision=1,
            section={"type":"text","heading":"Новый контент","text":"Текст"})
        self.assertEqual(result["revision"],2)
        self.assertEqual(result["section_count"],4)
        move=self.app.edit_structure(**self.args,slug="home",
            operation="move",index=1,target_index=3,expected_revision=2)
        self.assertEqual(move["revision"],3)
        self.assertEqual(self.app.get_spec(**self.args)["spec"]["pages"][0]
                         ["sections"][3]["heading"],"Новый контент")
        removed=self.app.edit_structure(**self.args,slug="home",
            operation="remove",index=3,expected_revision=3)
        self.assertEqual(removed["section_count"],3)
        self.assertEqual(removed["revision"],4)
        self.assertEqual(self.app.drafts.load(tenant=TENANT,project_id=self.project,
            revision=1)["pages"][0]["sections"],v1["pages"][0]["sections"])

    def test_cannot_delete_last_section(self):
        spec=self.app.get_spec(**self.args)["spec"]
        sec_count=len(spec["pages"][0]["sections"])
        for number in range(sec_count-1):
            self.app.edit_structure(**self.args,slug="home",operation="remove",
                index=0,expected_revision=number+1)
        with self.assertRaises(StructureDenied):
            self.app.edit_structure(**self.args,slug="home",operation="remove",
                index=0,expected_revision=sec_count)

    def test_invalid_added_section_and_unsupported_keys_denied(self):
        candidates=[
            {"type":"script","heading":"JS","code":"alert(1)"},
            {"type":"text","heading":"Test","text":"X","script":"x"},
            {"type":"contacts","heading":"Contact"},
            {"type":"table","heading":"Unknown","model":"other"},
        ]
        for section in candidates:
            with self.subTest(section=section),self.assertRaises(ValueError):
                self.app.edit_structure(**self.args,slug="home",operation="add",
                                        index=1,section=section,expected_revision=1)
        self.assertEqual(self.app.get_spec(**self.args)["revision"],1)

    def test_invalid_operation_stale_version_and_indices_denied(self):
        for operation,index,target in (
            ("execute",0,None),("move",0,100),("remove",99,None),
            ("add",300,None)
        ):
            with self.subTest(operation=operation),self.assertRaises(ValueError):
                self.app.edit_structure(**self.args,slug="home",operation=operation,
                   index=index,target_index=target,expected_revision=1)
        self.app.edit_structure(**self.args,slug="home",operation="move",
            index=0,target_index=1,expected_revision=1)
        with self.assertRaises(StructureDenied):
            self.app.edit_structure(**self.args,slug="home",operation="remove",
                                    index=0,expected_revision=1)

    def test_viewer_cannot_insert_or_remove(self):
        self.app.policy.add_member(tenant=TENANT,project_id=self.project,
            owner_actor=OWNER,member_actor=VIEWER,role="viewer",now=1799971201)
        with self.assertRaises(AppAccessDenied):
            self.app.edit_structure(tenant=TENANT,project_id=self.project,
                actor=VIEWER,slug="home",operation="remove",index=1,
                expected_revision=1)

    def test_xss_escaped_in_new_section(self):
        self.app.edit_structure(**self.args,slug="home",operation="add",
            index=1,expected_revision=1,section={
                "type":"text","heading":"<img src=x onerror=alert(1)>",
                "text":"<script>alert('x')</script>"})
        html=self.app.render_preview(**self.args)["index.html"].decode()
        self.assertNotIn("<script>",html)
        self.assertIn("&lt;script&gt;",html)


class StructureHTTPTests(Wave6Setup):
    def setUp(self):
        super().setUp()
        self.console=LocalConsole(self.db,tenant=TENANT,project_id=self.project,
                                  actor=OWNER,token=TOKEN,port=PORT)

    def post(self,path,body):
        payload=json.dumps(body).encode("utf-8")
        env={}
        setup_testing_defaults(env)
        env.update({"PATH_INFO":path,"REQUEST_METHOD":"POST",
                    "HTTP_HOST":f"127.0.0.1:{PORT}","REMOTE_ADDR":"127.0.0.1",
                    "CONTENT_TYPE":"application/json","CONTENT_LENGTH":str(len(payload)),
                    "wsgi.input":BytesIO(payload),"HTTP_AUTHORIZATION":"Bearer "+TOKEN})
        statuses=[]
        result=b"".join(self.console(env,lambda status,headers:statuses.append(status)))
        return statuses[0],json.loads(result)

    def test_http_structure_add_and_no_public_deploy(self):
        status,body=self.post("/api/v1/pages/home/structure",{
            "operation":"add","index":1,"expected_revision":1,
            "section":{"type":"text","heading":"Добавлено по API","text":"Тело"}})
        self.assertTrue(status.startswith("200"))
        self.assertFalse(body["production_published"])
        self.assertEqual(self.app.get_spec(**self.args)["revision"],2)

    def test_api_rejects_client_tenant_spoofing(self):
        status,_=self.post("/api/v1/pages/home/structure",{
            "operation":"remove","index":0,"expected_revision":1,
            "tenant_id":"tenant_other"})
        self.assertTrue(status.startswith("400"))
        self.assertEqual(self.app.get_spec(**self.args)["revision"],1)

    def test_api_rejects_missing_and_bad_structure_data(self):
        for body in ({"operation":"add","index":1,"expected_revision":1},
                     {"operation":"move","index":0,"expected_revision":1,
                      "target_index":-1},
                     {"operation":"remove","index":0,"expected_revision":True}):
            with self.subTest(body=body):
                status,_=self.post("/api/v1/pages/home/structure",body)
                self.assertTrue(status.startswith("400"))
        self.assertEqual(self.app.get_spec(**self.args)["revision"],1)

if __name__=="__main__":
    unittest.main()
