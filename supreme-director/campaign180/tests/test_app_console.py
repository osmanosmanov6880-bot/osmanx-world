"""TITAN X22/X23 local app HTTP, permission, workflow and UI integration tests."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import secrets
import sqlite3
import tempfile
import unittest
import uuid
from wsgiref.util import setup_testing_defaults

from campaign180.app_policy import LocalAppPolicy,AppAccessDenied
from campaign180.app_runtime import LocalAppRuntime,AppOperationDenied,RULE_SCHEMA
from campaign180.local_http import LocalConsole,ConsoleDenied
from campaign180.drafts import DraftDenied

REPO=Path(__file__).resolve().parents[3]
DEMO=REPO/"supreme-director/campaign180/examples/demo-site.json"
TENANT="tenant_demo"
OWNER="owner-abc"
EDITOR="editor-abc"
VIEWER="viewer-abc"
OPERATOR="operator-abc"
TOKEN="A1B2C3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ_-LOCAL_TEST_TOKEN"
PORT=8765

def base_spec():
    return json.loads(DEMO.read_text(encoding="utf-8"))

def unique(prefix="key"):
    return prefix+"-"+uuid.uuid4().hex

def rule(*,action="followup@example.org",cond=None,trigger="manual"):
    return {
        "schema":RULE_SCHEMA,"name":"Отметить обращение",
        "model":"customers","trigger":trigger,
        "condition":cond,
        "action":{"type":"set_field","field":"email","value":action}
    }


class Setup(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.database=Path(tmp.name)/"app.sqlite3"
        self.project=base_spec()["project_id"]
        self.runtime=LocalAppRuntime(str(self.database))
        self.runtime.drafts.create(base_spec(),tenant=TENANT)
        self.runtime.policy.bootstrap_owner(tenant=TENANT,project_id=self.project,
            actor=OWNER,now=1799971200)

    def member(self,actor,role):
        return self.runtime.policy.add_member(tenant=TENANT,
            project_id=self.project,owner_actor=OWNER,member_actor=actor,
            role=role,now=1799971201)

    def create(self,actor=OWNER,name="Ада"):
        return self.runtime.create_row(tenant=TENANT,project_id=self.project,
            actor=actor,model="customers",data={"name":name},
            idempotency_key=unique())


class AppPolicyTests(Setup):
    def test_bootstrap_once_and_owner_only_delegation(self):
        with self.assertRaises(AppAccessDenied):
            self.runtime.policy.bootstrap_owner(tenant=TENANT,
                project_id=self.project,actor=OWNER,now=1799971202)
        self.member(VIEWER,"viewer")
        with self.runtime.drafts._db() as db:
            viewer=self.runtime.policy.require(db,tenant=TENANT,project_id=self.project,
                actor=VIEWER,capability="spec.read")
            self.assertEqual(viewer["role"],"viewer")
            with self.assertRaises(AppAccessDenied):
                self.runtime.policy.require(db,tenant=TENANT,project_id=self.project,
                    actor=VIEWER,capability="record.write")
        with self.assertRaises(AppAccessDenied):
            self.runtime.policy.add_member(tenant=TENANT,project_id=self.project,
                owner_actor=VIEWER,member_actor=EDITOR,role="editor",now=1799971202)

    def test_cannot_grant_new_owner_or_revoke_owner(self):
        with self.assertRaises(AppAccessDenied):
            self.runtime.policy.add_member(tenant=TENANT,project_id=self.project,
                owner_actor=OWNER,member_actor=EDITOR,role="owner",now=1799971202)
        with self.assertRaises(AppAccessDenied):
            self.runtime.policy.revoke_member(tenant=TENANT,project_id=self.project,
                owner_actor=OWNER,member_actor=OWNER,now=1799971202)

    def test_immediate_revocation_blocks_queued_local_write(self):
        self.member(OPERATOR,"operator")
        self.runtime.policy.revoke_member(tenant=TENANT,project_id=self.project,
            owner_actor=OWNER,member_actor=OPERATOR,now=1799971203)
        with self.assertRaises(AppAccessDenied):
            self.create(OPERATOR)
        self.assertEqual(self.runtime.list_rows(tenant=TENANT,
            project_id=self.project,actor=OWNER,model="customers"),[])

    def test_permissions_are_project_scoped_even_with_same_actor(self):
        other=base_spec()
        other["project_id"]=str(uuid.uuid4())
        self.runtime.drafts.create(other,tenant=TENANT)
        with self.assertRaises(AppAccessDenied):
            self.runtime.get_spec(tenant=TENANT,project_id=other["project_id"],actor=OWNER)
        other["tenant_id"]="tenant_other"
        other["project_id"]=str(uuid.uuid4())
        self.runtime.drafts.create(other,tenant="tenant_other")
        with self.assertRaises(AppAccessDenied):
            self.runtime.get_spec(tenant="tenant_other",
                project_id=other["project_id"],actor=OWNER)

    def test_role_downgrade_and_reprovision_change_permissions(self):
        self.member(EDITOR,"editor")
        self.create(EDITOR)
        self.member(EDITOR,"viewer")
        with self.assertRaises(AppAccessDenied):
            self.create(EDITOR)
        role=self.runtime.policy.get_role(tenant=TENANT,project_id=self.project,
                                          actor=EDITOR)
        self.assertNotIn("record.write",role["capabilities"])


class AppRuntimeTests(Setup):
    def test_atomic_edit_page_and_immutable_revision(self):
        result=self.runtime.edit_page(tenant=TENANT,project_id=self.project,
            actor=OWNER,slug="home",expected_revision=1,section_index=0,
            changes={"heading":"Новая рабочая область"})
        self.assertEqual(result["revision"],2)
        source=self.runtime.get_spec(tenant=TENANT,project_id=self.project,actor=OWNER)
        self.assertEqual(source["spec"]["pages"][0]["sections"][0]["heading"],
                         "Новая рабочая область")
        self.assertEqual(self.runtime.drafts.load(tenant=TENANT,
            project_id=self.project,revision=1)["pages"][0]["sections"][0]["heading"],
                         "Рабочие процессы без лишней сложности")

    def test_editor_and_viewer_rights_for_project_edits(self):
        self.member(VIEWER,"viewer")
        self.member(EDITOR,"editor")
        with self.assertRaises(AppAccessDenied):
            self.runtime.edit_page(tenant=TENANT,project_id=self.project,
                actor=VIEWER,slug="home",expected_revision=1,title="Не мой доступ")
        changed=self.runtime.edit_page(tenant=TENANT,project_id=self.project,
            actor=EDITOR,slug="home",expected_revision=1,title="Редактор")
        self.assertTrue(changed["changed"])

    def test_concurrent_page_edits_only_one_wins(self):
        self.member(EDITOR,"editor")
        def edit(i):
            try:
                self.runtime.edit_page(tenant=TENANT,project_id=self.project,
                    actor=EDITOR,slug="home",expected_revision=1,
                    title="Версия "+str(i))
                return 1
            except AppOperationDenied:return 0
        with ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(edit,range(12)))
        self.assertEqual(sum(results),1)

    def test_create_update_delete_records_with_role_and_cas(self):
        self.member(OPERATOR,"operator")
        made=self.create(OPERATOR)
        changed=self.runtime.update_row(tenant=TENANT,project_id=self.project,
            actor=OPERATOR,model="customers",row_id=made["row_id"],
            expected_version=1,changes={"email":"new@example.org"},
            idempotency_key=unique())
        self.assertEqual(changed["version"],2)
        with self.assertRaises(AppOperationDenied):
            self.runtime.update_row(tenant=TENANT,project_id=self.project,
                actor=OPERATOR,model="customers",row_id=made["row_id"],
                expected_version=1,changes={"name":"Потерянная правка"},
                idempotency_key=unique())
        removed=self.runtime.delete_row(tenant=TENANT,project_id=self.project,
            actor=OPERATOR,model="customers",row_id=made["row_id"],
            expected_version=2,idempotency_key=unique())
        self.assertTrue(removed["deleted"])
        self.assertEqual(self.runtime.list_rows(tenant=TENANT,project_id=self.project,
            actor=OWNER,model="customers"),[])

    def test_record_idempotency_collision_no_duplicate(self):
        item={"name":"Один"}
        idem=unique()
        first=self.runtime.create_row(tenant=TENANT,project_id=self.project,
            actor=OWNER,model="customers",data=item,idempotency_key=idem)
        self.assertEqual(first,self.runtime.create_row(tenant=TENANT,
            project_id=self.project,actor=OWNER,model="customers",data=item,
            idempotency_key=idem))
        with self.assertRaises(ValueError):
            self.runtime.create_row(tenant=TENANT,project_id=self.project,
                actor=OWNER,model="customers",data={"name":"Два"},
                idempotency_key=idem)
        self.assertEqual(len(self.runtime.list_rows(tenant=TENANT,
            project_id=self.project,actor=OWNER,model="customers")),1)

    def test_preview_cannot_be_rendered_after_revocation(self):
        self.member(VIEWER,"viewer")
        out=self.runtime.render_preview(tenant=TENANT,project_id=self.project,actor=VIEWER)
        self.assertIn("index.html",out)
        self.runtime.policy.revoke_member(tenant=TENANT,project_id=self.project,
            owner_actor=OWNER,member_actor=VIEWER,now=1799971204)
        with self.assertRaises(AppAccessDenied):
            self.runtime.render_preview(tenant=TENANT,project_id=self.project,actor=VIEWER)

    def test_workflow_validates_schema_and_permissions(self):
        self.member(OPERATOR,"operator")
        with self.assertRaises(AppAccessDenied):
            self.runtime.add_workflow(tenant=TENANT,project_id=self.project,
                actor=OPERATOR,rule=rule())
        for invalid in (
            {**rule(),"trigger":"external.webhook"},
            {**rule(),"action":{"type":"exec","command":"rm -rf /"}},
            {**rule(),"model":"other"},
            {**rule(),"condition":{"field":"unknown","equals":"X"}},
            {**rule(),"action":{"type":"set_field","field":"email","value":"bad-mail"}},
        ):
            with self.subTest(invalid=invalid),self.assertRaises(ValueError):
                self.runtime.add_workflow(tenant=TENANT,project_id=self.project,
                    actor=OWNER,rule=invalid)

    def test_manual_workflow_is_atomic_and_idempotent(self):
        target=self.create()
        wf=self.runtime.add_workflow(tenant=TENANT,project_id=self.project,
            actor=OWNER,rule=rule(cond={"field":"name","equals":"Ада"}))
        eid=str(uuid.uuid4())
        args={"tenant":TENANT,"project_id":self.project,"actor":OWNER,
              "workflow_id":wf["workflow_id"],"trigger":"manual",
              "event_id":eid,"row_id":target["row_id"]}
        one=self.runtime.run_workflow(**args)
        self.assertTrue(one["changed"])
        self.assertEqual(one["row_version"],2)
        self.assertEqual(one,self.runtime.run_workflow(**args))
        saved=self.runtime.list_rows(tenant=TENANT,project_id=self.project,
            actor=OWNER,model="customers")
        self.assertEqual(saved[0]["fields"]["email"],"followup@example.org")
        self.assertEqual(saved[0]["version"],2)
        with self.assertRaises(AppOperationDenied):
            self.runtime.run_workflow(**{**args,"row_id":str(uuid.uuid4())})

    def test_condition_miss_keeps_revision(self):
        target=self.create(name="Борис")
        wf=self.runtime.add_workflow(tenant=TENANT,project_id=self.project,
            actor=OWNER,rule=rule(cond={"field":"name","equals":"Ада"}))
        result=self.runtime.run_workflow(tenant=TENANT,project_id=self.project,
            actor=OWNER,workflow_id=wf["workflow_id"],event_id=str(uuid.uuid4()),
            trigger="manual",row_id=target["row_id"])
        self.assertFalse(result["matched"])
        self.assertFalse(result["changed"])
        self.assertEqual(result["row_version"],1)

    def test_disable_workflow_and_revoke_running_role(self):
        target=self.create()
        wf=self.runtime.add_workflow(tenant=TENANT,project_id=self.project,
            actor=OWNER,rule=rule())
        self.member(OPERATOR,"operator")
        self.runtime.policy.revoke_member(tenant=TENANT,project_id=self.project,
            owner_actor=OWNER,member_actor=OPERATOR,now=1799971204)
        with self.assertRaises(AppAccessDenied):
            self.runtime.run_workflow(tenant=TENANT,project_id=self.project,
                actor=OPERATOR,workflow_id=wf["workflow_id"],
                event_id=str(uuid.uuid4()),trigger="manual",row_id=target["row_id"])
        disabled=self.runtime.disable_workflow(tenant=TENANT,project_id=self.project,
            actor=OWNER,workflow_id=wf["workflow_id"],expected_revision=1)
        self.assertFalse(disabled["enabled"])
        with self.assertRaises(AppOperationDenied):
            self.runtime.run_workflow(tenant=TENANT,project_id=self.project,
                actor=OWNER,workflow_id=wf["workflow_id"],
                event_id=str(uuid.uuid4()),trigger="manual",row_id=target["row_id"])

    def test_tampered_rule_fails_before_record_mutation(self):
        customer=self.create()
        wf=self.runtime.add_workflow(tenant=TENANT,project_id=self.project,
            actor=OWNER,rule=rule())
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE app_workflows SET spec_json='{}' WHERE workflow_id=?",
                       (wf["workflow_id"],))
        with self.assertRaises(AppOperationDenied):
            self.runtime.run_workflow(tenant=TENANT,project_id=self.project,
                actor=OWNER,workflow_id=wf["workflow_id"],event_id=str(uuid.uuid4()),
                trigger="manual",row_id=customer["row_id"])
        value=self.runtime.list_rows(tenant=TENANT,project_id=self.project,
            actor=OWNER,model="customers")[0]
        self.assertEqual(value["version"],1)


class HTTPTests(Setup):
    def setUp(self):
        super().setUp()
        self.web=LocalConsole(self.database,tenant=TENANT,
            project_id=self.project,actor=OWNER,token=TOKEN,port=PORT)

    def request(self,path,*,method="GET",body=None,token=TOKEN,origin=None,
                host=f"127.0.0.1:{PORT}",remote="127.0.0.1",
                content_type="application/json",raw=None,extra=None):
        status=[]
        headers=[]
        def start(code,h):
            status.append(code);headers.extend(h)
        env={}
        setup_testing_defaults(env)
        env.update({"PATH_INFO":path,"REQUEST_METHOD":method,"HTTP_HOST":host,
                    "REMOTE_ADDR":remote,"QUERY_STRING":""})
        if token is not None:env["HTTP_AUTHORIZATION"]="Bearer "+token
        if origin is not None:env["HTTP_ORIGIN"]=origin
        if body is not None or raw is not None:
            payload=raw if raw is not None else json.dumps(body).encode()
            env.update({"CONTENT_LENGTH":str(len(payload)),
                        "CONTENT_TYPE":content_type,"wsgi.input":BytesIO(payload)})
        if extra:env.update(extra)
        contents=b"".join(self.web(env,start))
        is_json=any(k.lower()=="content-type" and "application/json" in v for k,v in headers)
        result=json.loads(contents) if is_json else contents
        return status[0],dict(headers),result

    def test_api_requires_bearer_and_server_assigned_identity(self):
        code,headers,_=self.request("/api/v1/spec",token=None)
        self.assertTrue(code.startswith("401"))
        code,headers,_=self.request("/api/v1/spec",token="wrong")
        self.assertTrue(code.startswith("401"))
        code,headers,out=self.request("/api/v1/spec")
        self.assertTrue(code.startswith("200"))
        self.assertEqual(out["spec"]["tenant_id"],TENANT)
        self.assertEqual(out["revision"],1)
        self.assertEqual(headers["Cache-Control"],"no-store, max-age=0")
        self.assertIn("frame-ancestors 'none'",headers["Content-Security-Policy"])

    def test_missing_or_changed_host_and_remote_denied(self):
        for env in ({"host":"evil.example:8765"},
                    {"remote":"192.0.2.10"},
                    {"host":"localhost:8765"}):
            code,_,_=self.request("/api/v1/spec",**env)
            self.assertTrue(code.startswith("403"))

    def test_external_origin_and_forged_identity_rejected(self):
        code,_,_=self.request("/api/v1/models/customers",method="POST",
            body={"data":{"name":"Ада"},"idempotency_key":unique()},
            origin="https://attacker.example")
        self.assertTrue(code.startswith("403"))
        code,_,_=self.request("/api/v1/models/customers",method="POST",
            body={"data":{"name":"Ада"},"idempotency_key":unique(),
                  "tenant_id":"tenant_other","actor":"owner-abc"})
        self.assertTrue(code.startswith("400") or code.startswith("403"))
        self.assertEqual(self.runtime.list_rows(tenant=TENANT,
            project_id=self.project,actor=OWNER,model="customers"),[])

    def test_duplicate_json_and_nonfinite_numbers_denied(self):
        for raw in (b'{"data":{},"data":{}}',b'{"data":{"name":"X"},"idempotency_key":NaN}'):
            code,_,out=self.request("/api/v1/models/customers",method="POST",raw=raw)
            self.assertTrue(code.startswith("400"))
        code,_,_=self.request("/api/v1/models/customers",method="POST",
            raw=b"{}",content_type="text/plain")
        self.assertTrue(code.startswith("400"))

    def test_http_create_patch_delete_records_real_state(self):
        code,_,made=self.request("/api/v1/models/customers",method="POST",
            body={"data":{"name":"Марина"},"idempotency_key":unique()})
        self.assertTrue(code.startswith("201"))
        code,_,rows=self.request("/api/v1/models/customers")
        self.assertEqual(rows["rows"][0]["fields"]["name"],"Марина")
        code,_,change=self.request("/api/v1/models/customers/"+made["row_id"],
            method="PATCH",body={"expected_version":1,
                                 "changes":{"name":"М."},"idempotency_key":unique()})
        self.assertTrue(code.startswith("200"))
        self.assertEqual(change["version"],2)
        code,_,removed=self.request("/api/v1/models/customers/"+made["row_id"],
            method="DELETE",body={"expected_version":2,"idempotency_key":unique()})
        self.assertTrue(code.startswith("200"))
        self.assertTrue(removed["deleted"])
        self.assertEqual(self.request("/api/v1/models/customers")[2]["rows"],[])

    def test_http_page_edit_and_preview_is_static(self):
        code,_,edit=self.request("/api/v1/pages/home",method="PATCH",
            body={"expected_revision":1,"section_index":0,
                  "changes":{"heading":"Сайт из API"}})
        self.assertTrue(code.startswith("200"))
        code,_,preview=self.request("/api/v1/preview/home")
        self.assertTrue(code.startswith("200"))
        self.assertIn("Сайт из API",preview["html"])
        self.assertNotIn("<script>",preview["html"])
        self.assertFalse(preview["production_published"])

    def test_http_workflow_create_and_explicit_run(self):
        made=self.request("/api/v1/models/customers",method="POST",
            body={"data":{"name":"Ада"},"idempotency_key":unique()})[2]
        code,_,wf=self.request("/api/v1/workflows",method="POST",body={"rule":rule()})
        self.assertTrue(code.startswith("201"))
        code,_,list_response=self.request("/api/v1/workflows")
        self.assertEqual(len(list_response["workflows"]),1)
        code,_,run=self.request("/api/v1/workflows/"+wf["workflow_id"]+"/run",
            method="POST",body={"event_id":str(uuid.uuid4()),"trigger":"manual",
                                "row_id":made["row_id"]})
        self.assertTrue(code.startswith("200"))
        self.assertTrue(run["changed"])
        code,_,disabled=self.request("/api/v1/workflows/"+wf["workflow_id"]+"/disable",
            method="POST",body={"expected_revision":1})
        self.assertTrue(code.startswith("200"))
        self.assertFalse(disabled["enabled"])

    def test_viewer_api_may_read_but_never_write(self):
        self.member(VIEWER,"viewer")
        self.web=LocalConsole(self.database,tenant=TENANT,
            project_id=self.project,actor=VIEWER,token=TOKEN,port=PORT)
        self.assertTrue(self.request("/api/v1/spec")[0].startswith("200"))
        code,_,_=self.request("/api/v1/pages/home",method="PATCH",
            body={"expected_revision":1,"title":"Нельзя"})
        self.assertTrue(code.startswith("403"))
        code,_,_=self.request("/api/v1/models/customers",method="POST",
            body={"data":{"name":"Нельзя"},"idempotency_key":unique()})
        self.assertTrue(code.startswith("403"))
        code,_,_=self.request("/api/v1/workflows",method="POST",body={"rule":rule()})
        self.assertTrue(code.startswith("403"))

    def test_ui_assets_public_only_static_and_local(self):
        for path in ("/console","/assets/console.css","/assets/console.js"):
            code,headers,blob=self.request(path,token=None)
            self.assertTrue(code.startswith("200"))
            self.assertTrue(blob)
        js=self.request("/assets/console.js",token=None)[2].decode()
        self.assertNotIn("localStorage",js)
        self.assertNotIn("sessionStorage",js)
        self.assertNotIn("https://",js)
        self.assertIn("Authorization",js)
        self.assertIn("credentials:\"omit\"",js)

    def test_no_query_string_or_unsafe_method(self):
        code,_,_=self.request("/api/v1/spec",extra={"QUERY_STRING":"token=abc"})
        self.assertTrue(code.startswith("403"))
        code,_,_=self.request("/api/v1/spec",method="PUT")
        self.assertTrue(code.startswith("405"))
        code,_,_=self.request("/api/v1/unknown")
        self.assertTrue(code.startswith("404"))

if __name__=="__main__":
    unittest.main()
