"""Wave 15: real, authorized local form submissions (TITAN-X21/X22)."""
from io import BytesIO
import json
from pathlib import Path
import secrets
import tempfile
import unittest
import uuid
from wsgiref.util import setup_testing_defaults

from campaign180.app_runtime import LocalAppRuntime, RULE_SCHEMA
from campaign180.app_policy import AppAccessDenied
from campaign180.form_submissions import FormSubmissionDenied
from campaign180.local_http import LocalConsole

ROOT=Path(__file__).resolve().parents[3]
DEMO=ROOT/"supreme-director/campaign180/examples/demo-site.json"
TENANT="tenant_demo"
OWNER="owner-abc"
VIEWER="viewer-abc"
OPERATOR="operator-abc"
TOKEN="FormSubmissionLOCAL_Test_1234567890_abcdef_GHIJKLMN"
PORT=8766


class FormSubmissionTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db=Path(tmp.name)/"site.sqlite3"
        spec=json.loads(DEMO.read_text(encoding="utf-8"))
        spec["pages"][0]["sections"].append({
            "type":"form", "heading":"Новый клиент", "model":"customers",
            "fields":["name","email"],"button_label":"Сохранить",
        })
        self.section=len(spec["pages"][0]["sections"])-1
        spec["pages"][0]["sections"].append({
            "type":"form","heading":"Заявка","model":"requests",
            "fields":["customer","summary","value"],"button_label":"Отправить",
        })
        self.request_section=len(spec["pages"][0]["sections"])-1
        self.project=spec["project_id"]
        self.runtime=LocalAppRuntime(str(self.db))
        self.runtime.drafts.create(spec,tenant=TENANT)
        self.runtime.policy.bootstrap_owner(tenant=TENANT,project_id=self.project,
                                            actor=OWNER,now=1799971200)

    def payload(self,**changes):
        body={"tenant":TENANT,"project_id":self.project,"actor":OWNER,
              "slug":"home","section_index":self.section,
              "expected_revision":1,"data":{"name":"Тестовый клиент"},
              "idempotency_key":"form-"+uuid.uuid4().hex}
        body.update(changes)
        return body

    def submit(self,**changes):
        return self.runtime.submit_form(**self.payload(**changes))

    def rows(self):
        return self.runtime.list_rows(tenant=TENANT,project_id=self.project,
                                      actor=OWNER,model="customers")

    def test_atomic_create_with_receipt_and_actual_database_record(self):
        made=self.submit()
        self.assertTrue(made["persisted_locally"])
        self.assertFalse(made["production_published"])
        self.assertEqual(made["version"],1)
        self.assertEqual(self.rows()[0]["row_id"],made["row_id"])
        self.assertEqual(self.rows()[0]["fields"]["name"],"Тестовый клиент")

    def test_retry_is_idempotent_and_reused_key_for_changed_payload_denied(self):
        inp=self.payload()
        first=self.runtime.submit_form(**inp)
        again=self.runtime.submit_form(**inp)
        self.assertEqual(first,again)
        self.assertEqual(len(self.rows()),1)
        inp["data"]={"name":"Другой"}
        with self.assertRaises(ValueError):self.runtime.submit_form(**inp)
        self.assertEqual(len(self.rows()),1)

    def test_stale_version_and_non_form_section_are_denied(self):
        with self.assertRaises(FormSubmissionDenied):
            self.submit(expected_revision=99)
        with self.assertRaises(FormSubmissionDenied):
            self.submit(section_index=0)
        self.assertEqual(self.rows(),[])

    def test_hidden_unknown_missing_required_and_type_errors_are_denied(self):
        for data in ({"email":"a@example.org"},
                     {"name":"ok","invisible":"secret"},
                     {"name":4},
                     {"name":"ok","email":"not-an-email"}):
            with self.subTest(data=data):
                with self.assertRaises(ValueError):self.submit(data=data)
        self.assertEqual(self.rows(),[])

    def test_operator_can_submit_but_viewer_cannot(self):
        for actor,role in ((VIEWER,"viewer"),(OPERATOR,"operator")):
            self.runtime.policy.add_member(tenant=TENANT,project_id=self.project,
                owner_actor=OWNER,member_actor=actor,role=role,now=1799971201)
        with self.assertRaises(AppAccessDenied):self.submit(actor=VIEWER)
        made=self.submit(actor=OPERATOR)
        self.assertEqual(len(self.rows()),1)
        self.assertEqual(made["row_id"],self.rows()[0]["row_id"])

    def test_revocation_precedes_idempotent_replay(self):
        self.runtime.policy.add_member(tenant=TENANT,project_id=self.project,
            owner_actor=OWNER,member_actor=OPERATOR,role="operator",now=1799971201)
        inp=self.payload(actor=OPERATOR)
        self.runtime.submit_form(**inp)
        self.runtime.policy.revoke_member(tenant=TENANT,project_id=self.project,
            owner_actor=OWNER,member_actor=OPERATOR,now=1799971202)
        with self.assertRaises(AppAccessDenied):self.runtime.submit_form(**inp)
        self.assertEqual(len(self.rows()),1)

    def test_cross_tenant_and_project_form_submit_fails(self):
        with self.assertRaises(ValueError):self.submit(tenant="tenant_other")
        with self.assertRaises(ValueError):self.submit(project_id=str(uuid.uuid4()))
        self.assertEqual(self.rows(),[])

    def test_invalid_form_index_and_empty_key_fail_closed(self):
        with self.assertRaises(FormSubmissionDenied):self.submit(section_index=True)
        with self.assertRaises(ValueError):self.submit(idempotency_key="bad")
        self.assertEqual(self.rows(),[])

    def test_form_submission_creates_checked_reference_link(self):
        customer=self.submit()
        request=self.submit(
            section_index=self.request_section,
            data={"customer":customer["row_id"],"summary":"Новая заявка","value":1200},
        )
        records=self.runtime.list_rows(tenant=TENANT,project_id=self.project,
                                       actor=OWNER,model="requests")
        self.assertEqual(records[0]["row_id"],request["row_id"])
        self.assertEqual(records[0]["fields"]["customer"],customer["row_id"])
        with self.runtime.drafts._db() as db:
            linked=db.execute("SELECT target_row_id FROM builder_links WHERE tenant=?"
                              " AND project_id=? AND model='requests' AND row_id=?",
                              (TENANT,self.project,request["row_id"])).fetchone()
        self.assertEqual(linked["target_row_id"],customer["row_id"])

    def test_foreign_or_missing_reference_rolls_back_whole_submission(self):
        with self.assertRaises(ValueError):
            self.submit(section_index=self.request_section,
                        data={"customer":str(uuid.uuid4()),"summary":"Чужая ссылка"})
        self.assertEqual(
            self.runtime.list_rows(tenant=TENANT,project_id=self.project,
                                   actor=OWNER,model="requests"),[],
        )

    def test_record_created_workflow_executes_in_same_submission(self):
        rule={"schema":RULE_SCHEMA,"name":"При поступлении заявки",
              "model":"customers","trigger":"record.created","condition":None,
              "action":{"type":"set_field","field":"email",
                        "value":"auto@example.org"}}
        self.runtime.add_workflow(tenant=TENANT,project_id=self.project,actor=OWNER,
                                  rule=rule)
        result=self.submit()
        self.assertEqual(result["automatic_workflows"]["dispatched"],1)
        self.assertEqual(result["automatic_workflows"]["changed"],1)
        self.assertEqual(self.rows()[0]["fields"]["email"],"auto@example.org")
        self.assertEqual(self.rows()[0]["version"],2)

    def test_required_fields_must_be_exposed_by_the_selected_form(self):
        spec,rev=self.runtime.get_spec(tenant=TENANT,project_id=self.project,actor=OWNER)["spec"],1
        spec["pages"][0]["sections"][self.request_section]["fields"]=["summary"]
        self.runtime.drafts.save(tenant=TENANT,project_id=self.project,
                                 expected_revision=rev,spec=spec)
        with self.assertRaises(FormSubmissionDenied):
            self.submit(section_index=self.request_section,expected_revision=2,
                        data={"summary":"Без обязательной ссылки"})
        self.assertEqual(self.rows(),[])

    def call(self,path,body,token=TOKEN):
        web=LocalConsole(self.db,tenant=TENANT,project_id=self.project,
                         actor=OWNER,token=TOKEN,port=PORT)
        env={};setup_testing_defaults(env)
        payload=json.dumps(body).encode("utf-8")
        env.update({"REQUEST_METHOD":"POST","PATH_INFO":path,
                    "HTTP_HOST":f"127.0.0.1:{PORT}","REMOTE_ADDR":"127.0.0.1",
                    "CONTENT_TYPE":"application/json","CONTENT_LENGTH":str(len(payload)),
                    "HTTP_AUTHORIZATION":"Bearer "+token,"QUERY_STRING":"",
                    "wsgi.input":BytesIO(payload)})
        statuses=[]
        result=b"".join(web(env,lambda status,headers:statuses.append(status)))
        return statuses[0],json.loads(result)

    def test_real_http_submission_and_duplicate_replay(self):
        payload={"section_index":self.section,"expected_revision":1,
                 "data":{"name":"HTTP клиент"},
                 "idempotency_key":"http-"+uuid.uuid4().hex}
        route="/api/v1/forms/home/submit"
        code,first=self.call(route,payload)
        self.assertTrue(code.startswith("201"),(code,first))
        again_code,again=self.call(route,payload)
        self.assertTrue(again_code.startswith("201"))
        self.assertEqual(first,again)
        self.assertEqual(len(self.rows()),1)

    def test_http_requires_auth_and_never_trusts_identity(self):
        body={"section_index":self.section,"expected_revision":1,
              "data":{"name":"HTTP"},"idempotency_key":"http-"+uuid.uuid4().hex}
        code,_=self.call("/api/v1/forms/home/submit",body,token="wrong")
        self.assertTrue(code.startswith("401"))
        forged={**body,"actor":OWNER,"tenant":TENANT}
        code,_=self.call("/api/v1/forms/home/submit",forged)
        self.assertTrue(code.startswith("400"))
        self.assertEqual(self.rows(),[])


if __name__=="__main__":unittest.main()
