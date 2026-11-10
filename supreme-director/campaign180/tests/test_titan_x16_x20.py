"""Original TITAN-X16..X20: real local integration and failure-mode tests.

Covers stage provenance, deterministic static source archives, Ed25519
review signatures, bounded workflow corrections, and no-AI page editing
through the real WSGI endpoint. This is not upstream acceptance.
"""
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import secrets
import sqlite3
import subprocess
import tempfile
import unittest
import uuid
import zipfile
from wsgiref.util import setup_testing_defaults

from campaign180.contracts import digest
from campaign180.workflow import LocalProjectFlow,WorkflowDenied
from campaign180.builder import (
    SiteSpecDenied,compile_verified_site,verify_compiled_site,render_site)
from campaign180.review import (
    PatchDenied,review_signing_message,verify_signed_patch_review)
from campaign180.titan_artifacts import public_key_fingerprint
from campaign180.app_runtime import LocalAppRuntime,RULE_SCHEMA
from campaign180.repair import LocalBoundedRepair,RepairDenied
from campaign180.structure import StructureDenied
from campaign180.local_http import LocalConsole

REPO=Path(__file__).resolve().parents[3]
TENANT="tenant_demo"
OWNER="owner-abc"
REVIEWER="reviewer-xyz"
NOW=1799971200
TOKEN="xYz12345ABCDeFgh56789ijklMNOpqrSSTUV0123456789-_"
PORT=18861

def demo():
    return json.loads((REPO/"supreme-director/campaign180/examples/demo-site.json").read_text("utf-8"))

def healthy_rule():
    return {"schema":RULE_SCHEMA,"name":"Safe deterministic rule",
            "model":"customers","trigger":"record.created","condition":None,
            "action":{"type":"set_field","field":"email","value":"fixed@example.org"}}

class StagedWorkflowTests(unittest.TestCase):
    def setUp(self):
        d=tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.db=Path(d.name)/"flow.sqlite"
        self.pid=str(uuid.uuid4())
        self.flow=LocalProjectFlow(self.db)
        self.flow.create(tenant=TENANT,project_id=self.pid,owner=OWNER,
                         brief={"objective":"local synthetic site"},now=NOW)

    def advance(self):
        self.flow.transition(tenant=TENANT,project_id=self.pid,actor=OWNER,
            expected_version=1,operation="spec",evidence={"features":["safe"]},now=NOW+1)
        code={"commit":"a"*40}
        self.flow.transition(tenant=TENANT,project_id=self.pid,actor=OWNER,
            expected_version=2,operation="code",evidence=code,now=NOW+2)
        self.flow.transition(tenant=TENANT,project_id=self.pid,actor=REVIEWER,
            expected_version=3,operation="approve",
            evidence={"reviewed_content_digest":digest(code)},now=NOW+3)
        self.flow.transition(tenant=TENANT,project_id=self.pid,actor=OWNER,
            expected_version=4,operation="candidate",
            evidence={"summary":"local candidate"},now=NOW+4)

    def test_x16_manifest_binds_spec_code_reviewer_and_workflow_head(self):
        self.advance()
        m=self.flow.candidate_manifest(tenant=TENANT,project_id=self.pid)
        self.assertEqual(m["version"],5)
        self.assertEqual(m["owner"],OWNER)
        self.assertEqual(m["reviewer"],REVIEWER)
        self.assertEqual(m["code_sha256"],digest({"commit":"a"*40}))
        self.assertEqual(m["head_hash"],self.flow.inspect(
            tenant=TENANT,project_id=self.pid)["head_hash"])
        self.assertRegex(m["manifest_sha256"],r"^[0-9a-f]{64}$")
        self.assertFalse(m["production_release"])
        self.assertFalse(m["independent_identity_verified"])

    def test_x16_unreviewed_and_cancelled_projects_have_no_candidate(self):
        with self.assertRaises(WorkflowDenied):
            self.flow.candidate_manifest(tenant=TENANT,project_id=self.pid)
        self.flow.transition(tenant=TENANT,project_id=self.pid,actor=OWNER,
            expected_version=1,operation="cancel",evidence={"reason":"pause"},now=NOW+1)
        with self.assertRaises(WorkflowDenied):
            self.flow.candidate_manifest(tenant=TENANT,project_id=self.pid)
        self.assertEqual(self.flow.inspect(tenant=TENANT,project_id=self.pid)["stage"],
                         "cancelled")
        self.flow.transition(tenant=TENANT,project_id=self.pid,actor=OWNER,
            expected_version=2,operation="resume",evidence={"spec":"new"},now=NOW+2)
        self.assertEqual(self.flow.inspect(tenant=TENANT,project_id=self.pid)["stage"],
                         "spec")
        with self.assertRaises(WorkflowDenied):
            self.flow.candidate_manifest(tenant=TENANT,project_id=self.pid)

    def test_x16_cancelled_project_cannot_resume_by_foreign_actor(self):
        self.flow.transition(tenant=TENANT,project_id=self.pid,actor=OWNER,
            expected_version=1,operation="cancel",evidence={"reason":"stop"},now=NOW+1)
        with self.assertRaises(WorkflowDenied):
            self.flow.transition(tenant=TENANT,project_id=self.pid,actor=REVIEWER,
                expected_version=2,operation="resume",evidence={"spec":"forged"},now=NOW+2)
        with self.assertRaises(WorkflowDenied):
            self.flow.transition(tenant="tenant_other",project_id=self.pid,actor=OWNER,
                expected_version=2,operation="resume",evidence={"spec":"cross"},now=NOW+2)

    def test_x16_manifest_detects_damaged_hash_ledger(self):
        self.advance()
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE local_project_events SET content_digest=? WHERE version=3",
                       ("0"*64,))
        with self.assertRaises(WorkflowDenied):
            self.flow.candidate_manifest(tenant=TENANT,project_id=self.pid)

class GeneratedCodeTests(unittest.TestCase):
    def test_x17_real_static_code_zip_reproducible_and_verifiable(self):
        spec=demo()
        h=digest(spec)
        first=compile_verified_site(spec,expected_spec_sha256=h)
        second=compile_verified_site(spec,expected_spec_sha256=h)
        self.assertEqual(first["bundle"],second["bundle"])
        self.assertEqual(first["bundle_sha256"],second["bundle_sha256"])
        checked=verify_compiled_site(first["bundle"],
            expected_bundle_sha256=first["bundle_sha256"],
            expected_spec_sha256=h)
        self.assertEqual(checked["files_verified"],len(spec["pages"]))
        with zipfile.ZipFile(BytesIO(first["bundle"])) as z:
            self.assertIn("site-build-manifest.json",z.namelist())
            self.assertIn("index.html",z.namelist())
            self.assertIn(b"Content-Security-Policy",z.read("index.html"))
        self.assertFalse(first["production_published"])

    def test_x17_stale_spec_and_bad_contract_rejected(self):
        raw=demo()
        original=digest(raw)
        changed=deepcopy(raw)
        changed["pages"][0]["title"]="Different"
        with self.assertRaises(SiteSpecDenied):
            compile_verified_site(changed,expected_spec_sha256=original)
        with self.assertRaises(SiteSpecDenied):
            compile_verified_site(raw,expected_spec_sha256="0"*64)
        changed["remote_script"]="http://invalid.example/x.js"
        with self.assertRaises(SiteSpecDenied):
            compile_verified_site(changed,expected_spec_sha256=original)

    def test_x17_tampered_zip_and_wrong_expected_digest_rejected(self):
        h=digest(demo())
        built=compile_verified_site(demo(),expected_spec_sha256=h)
        changed=built["bundle"]+b"tamper"
        with self.assertRaises(SiteSpecDenied):
            verify_compiled_site(changed,expected_bundle_sha256=built["bundle_sha256"],
                                 expected_spec_sha256=h)
        with self.assertRaises(SiteSpecDenied):
            verify_compiled_site(built["bundle"],expected_bundle_sha256="0"*64,
                                 expected_spec_sha256=h)

class IndependentPatchTests(unittest.TestCase):
    def proposal(self):
        return {"schema":"osgard.original180.patch-proposal/1",
                "author":OWNER,"reviewer":REVIEWER,
                "changes":[{
                    "path":"supreme-director/campaign180/campaign180/x18_safe_example.py",
                    "base_sha256":None,
                    "content_base64":"eCA9IDEK",  # x = 1\n
                }]}

    def test_x18_real_ed25519_signature_and_pinned_reviewer_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            private=root/"reviewer.key"
            pub=root/"reviewer.pub"
            subprocess.run(["openssl","genpkey","-algorithm","ed25519",
                "-out",str(private)],capture_output=True,check=True)
            subprocess.run(["openssl","pkey","-in",str(private),"-pubout",
                "-out",str(pub)],capture_output=True,check=True)
            proposal=self.proposal()
            signed=review_signing_message(REPO,proposal)
            inp=root/"signed.json";inp.write_bytes(signed)
            signature=root/"signed.bin"
            subprocess.run(["openssl","pkeyutl","-sign","-inkey",str(private),
                "-rawin","-in",str(inp),"-out",str(signature)],
                capture_output=True,check=True)
            actual=verify_signed_patch_review(REPO,proposal,
                signature=signature.read_bytes(),reviewer_public_key=pub,
                trusted_key_sha256=public_key_fingerprint(pub))
            self.assertTrue(actual["ed25519_signature_valid"])
            self.assertFalse(actual["github_review_verified"])
            self.assertFalse(actual["product_merge_authorized"])
            with self.assertRaises(PatchDenied):
                verify_signed_patch_review(REPO,proposal,
                    signature=signature.read_bytes(),reviewer_public_key=pub,
                    trusted_key_sha256="0"*64)
            modified=self.proposal()
            modified["changes"][0]["content_base64"]="eCA9IDIK"
            with self.assertRaises(PatchDenied):
                verify_signed_patch_review(REPO,modified,
                    signature=signature.read_bytes(),reviewer_public_key=pub,
                    trusted_key_sha256=public_key_fingerprint(pub))

    def test_x18_declared_self_review_and_unsafe_patch_denied(self):
        proposal=self.proposal()
        proposal["reviewer"]=proposal["author"]
        with self.assertRaises(PatchDenied):
            review_signing_message(REPO,proposal)
        proposal=self.proposal()
        proposal["changes"][0]["content_base64"]="ZXZhbCgiMSIpCg==" # eval("1")
        with self.assertRaises(PatchDenied):
            review_signing_message(REPO,proposal)

class RepairAndEditorTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db=Path(tmp.name)/"app.sqlite"
        self.app=LocalAppRuntime(str(self.db))
        self.doc=demo()
        self.pid=self.doc["project_id"]
        self.app.drafts.create(self.doc,tenant=TENANT)
        self.app.policy.bootstrap_owner(tenant=TENANT,project_id=self.pid,
                                        actor=OWNER,now=NOW)
        self.repair=LocalBoundedRepair(self.app)

    def quarantine(self):
        wf=self.app.add_workflow(tenant=TENANT,project_id=self.pid,
                                actor=OWNER,rule=healthy_rule())
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE app_workflows SET spec_json='{}' WHERE workflow_id=?",
                       (wf["workflow_id"],))
        plan=self.repair.inspect(tenant=TENANT,project_id=self.pid,
                                  actor=OWNER,limit=1)
        result=self.repair.apply(tenant=TENANT,project_id=self.pid,actor=OWNER,
                                 expected_sha256=plan["sha256"],now=NOW+3,limit=1)
        return wf["workflow_id"],result

    def test_x19_bounded_quarantine_and_verified_fix_enable(self):
        wf,receipt=self.quarantine()
        self.assertEqual(receipt["repaired"],1)
        self.assertEqual(receipt["budget_remaining"],11)
        preview=self.repair.inspect_replacement(tenant=TENANT,project_id=self.pid,
            actor=OWNER,workflow_id=wf,replacement_rule=healthy_rule())
        self.assertFalse(preview["applied"])
        with self.assertRaises(RepairDenied):
            self.repair.apply_replacement(tenant=TENANT,project_id=self.pid,
                actor=OWNER,workflow_id=wf,replacement_rule=healthy_rule(),
                expected_sha256="0"*64,now=NOW+5)
        corrected=self.repair.apply_replacement(tenant=TENANT,
            project_id=self.pid,actor=OWNER,workflow_id=wf,
            replacement_rule=healthy_rule(),expected_sha256=preview["sha256"],
            now=NOW+5)
        self.assertTrue(corrected["enabled"])
        self.assertEqual(corrected["revision"],3)
        self.assertFalse(corrected["production_published"])
        with sqlite3.connect(self.db) as db:
            count=db.execute("SELECT COUNT(*) FROM app_workflow_replacements").fetchone()[0]
            self.assertEqual(count,1)
        with self.assertRaises(RepairDenied):
            self.repair.apply_replacement(tenant=TENANT,project_id=self.pid,
                actor=OWNER,workflow_id=wf,replacement_rule=healthy_rule(),
                expected_sha256=preview["sha256"],now=NOW+6)

    def test_x19_bad_replacement_never_reenabled(self):
        wf,_=self.quarantine()
        corrupted={**healthy_rule(),"model":"unknown_model"}
        with self.assertRaises(ValueError):
            self.repair.inspect_replacement(tenant=TENANT,project_id=self.pid,
                actor=OWNER,workflow_id=wf,replacement_rule=corrupted)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT enabled FROM app_workflows").fetchone()[0],0)

    def page(self,op,slug,revision,target_slug=None,title=None,target_index=None):
        return self.app.edit_pages(tenant=TENANT,project_id=self.pid,
             actor=OWNER,expected_revision=revision,operation=op,slug=slug,
             target_slug=target_slug,title=title,target_index=target_index)

    def test_x20_create_copy_rename_reorder_remove_real_sqlite(self):
        init=len(self.doc["pages"])
        created=self.page("add","services",1,title="Услуги")
        self.assertEqual(created["revision"],2)
        self.assertEqual(created["page_count"],init+1)
        cloned=self.page("duplicate","services",2,target_slug="services-more",
                         title="Другие услуги")
        self.assertEqual(cloned["revision"],3)
        renamed=self.page("rename","services-more",3,target_slug="offers",
                         title="Предложения")
        self.assertEqual(renamed["revision"],4)
        moved=self.page("move","offers",4,target_index=1)
        self.assertEqual(moved["revision"],5)
        deleted=self.page("remove","offers",5)
        self.assertEqual(deleted["revision"],6)
        pages=self.app.get_spec(tenant=TENANT,project_id=self.pid,actor=OWNER)["spec"]["pages"]
        self.assertEqual(len(pages),init+1)
        self.assertNotIn("offers",[p["slug"] for p in pages])
        self.assertIn("services.html",render_site(self.app.drafts.load(
            tenant=TENANT,project_id=self.pid)))
        old=self.app.drafts.load(tenant=TENANT,project_id=self.pid,revision=3)
        self.assertIn("services-more",[p["slug"] for p in old["pages"]])

    def test_x20_rename_updates_cta_links_atomically(self):
        spec=self.app.drafts.load(tenant=TENANT,project_id=self.pid)
        links=[section for page in spec["pages"] for section in page["sections"]
               if section.get("cta_page") and section["cta_page"]!="home"]
        if not links:
            # Create a guaranteed linked page within existing schema.
            spec["pages"][0]["sections"][0]["cta_label"]="Связаться"
            spec["pages"][0]["sections"][0]["cta_page"]="contact"
            self.app.drafts.save(tenant=TENANT,project_id=self.pid,
                expected_revision=1,spec=spec)
            version=2
        else:version=1
        renamed=self.page("rename","contact",version,target_slug="reach-us")
        self.assertEqual(renamed["revision"],version+1)
        result=self.app.drafts.load(tenant=TENANT,project_id=self.pid)
        self.assertTrue(any(section.get("cta_page")=="reach-us"
             for page in result["pages"] for section in page["sections"]))
        self.assertIn("reach-us.html",render_site(result))

    def test_x20_stale_revision_invalid_home_and_unresolved_cta_denied(self):
        self.page("add","services",1,title="Services")
        with self.assertRaises(StructureDenied):
            self.page("add","other",1,title="Other")
        with self.assertRaises(StructureDenied):
            self.page("remove","home",2)
        with self.assertRaises(StructureDenied):
            self.page("rename","home",2,target_slug="other")
        with self.assertRaises(StructureDenied):
            self.page("add","../invalid",2,title="Bad")
        self.assertEqual(self.app.drafts.current_revision(
            tenant=TENANT,project_id=self.pid)["revision"],2)

    def test_x20_viewer_forbidden_without_side_effect(self):
        self.app.policy.add_member(tenant=TENANT,project_id=self.pid,
             owner_actor=OWNER,member_actor="viewer-abc",role="viewer",now=NOW+1)
        with self.assertRaises(ValueError):
            self.app.edit_pages(tenant=TENANT,project_id=self.pid,
                actor="viewer-abc",expected_revision=1,operation="add",
                slug="services",title="Services")
        self.assertEqual(self.app.drafts.current_revision(
            tenant=TENANT,project_id=self.pid)["revision"],1)

    def test_x20_wsgi_editor_route_valid_and_unknown_field_denied(self):
        app=LocalConsole(self.db,tenant=TENANT,project_id=self.pid,
                         actor=OWNER,token=TOKEN,port=PORT)
        def post(body):
            raw=json.dumps(body).encode()
            env={}
            setup_testing_defaults(env)
            env.update({"PATH_INFO":"/api/v1/pages/manage",
                        "REQUEST_METHOD":"POST","HTTP_HOST":f"127.0.0.1:{PORT}",
                        "REMOTE_ADDR":"127.0.0.1",
                        "CONTENT_TYPE":"application/json",
                        "CONTENT_LENGTH":str(len(raw)),
                        "HTTP_AUTHORIZATION":"Bearer "+TOKEN,
                        "wsgi.input":BytesIO(raw)})
            status=[]
            response=b"".join(app(env,lambda s,h:status.append(s)))
            return status[0],json.loads(response)
        status,result=post({"expected_revision":1,"operation":"add",
                            "slug":"services","title":"Services"})
        self.assertTrue(status.startswith("200"))
        self.assertEqual(result["revision"],2)
        invalid,_=post({"expected_revision":2,"operation":"add",
                        "slug":"other","title":"Other",
                        "tenant_id":"tenant_foreign"})
        self.assertTrue(invalid.startswith("400"))
        self.assertEqual(self.app.drafts.current_revision(
            tenant=TENANT,project_id=self.pid)["revision"],2)

if __name__=="__main__":
    unittest.main()
