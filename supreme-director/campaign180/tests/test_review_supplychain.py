"""TITAN-X18 local patch review and X26 no-network supply-chain scanning."""
import base64
from hashlib import sha256
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from campaign180.review import inspect_patch,PatchDenied
from campaign180.supplychain import scan_changed,scan_content,ScanDenied

REPO=Path(__file__).resolve().parents[3]
PREFIX="supreme-director/campaign180/"


class PatchTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root=Path(temp.name)
        (self.root/".github").mkdir(parents=True)
        shutil.copyfile(REPO/".github/CODEOWNERS",self.root/".github/CODEOWNERS")
        folder=self.root/PREFIX
        folder.mkdir(parents=True)
        self.target=folder/"sample.py"
        self.target.write_text("def answer():\n    return 42\n",encoding="utf-8")

    def proposal(self,body=b"def answer():\n    return 43\n",path=PREFIX+"sample.py",
                 existing=True,reviewer="reviewer-abc"):
        return {"schema":"osgard.original180.patch-proposal/1",
                "author":"owner-abc","reviewer":reviewer,"changes":[{
                "path":path,"base_sha256":sha256(self.target.read_bytes()).hexdigest()
                    if existing else None,
                "content_base64":base64.b64encode(body).decode("ascii")}]}

    def test_readonly_review_produces_hashes_not_merge_authority(self):
        old=self.target.read_bytes()
        x=inspect_patch(self.root,self.proposal())
        self.assertTrue(x["local_static_checks_pass"])
        self.assertEqual(x["files"][0]["old_sha256"],sha256(old).hexdigest())
        self.assertFalse(x["github_approval"])
        self.assertFalse(x["independent_reviewer_verified"])
        self.assertFalse(x["product_merge_authorized"])
        self.assertEqual(self.target.read_bytes(),old)

    def test_stale_existing_base_rejected(self):
        proposal=self.proposal()
        self.target.write_text("modified concurrently")
        with self.assertRaises(PatchDenied):
            inspect_patch(self.root,proposal)

    def test_self_review_and_bad_author_denied(self):
        with self.assertRaises(PatchDenied):
            inspect_patch(self.root,self.proposal(reviewer="owner-abc"))
        x=self.proposal()
        x["author"]=" "
        with self.assertRaises(PatchDenied):
            inspect_patch(self.root,x)

    def test_cannot_change_original_master_or_repo_workflow(self):
        for name in ("supreme-director/originals/DIRECTOR_MASTER_180.md",
                     ".github/workflows/deploy.yml","../escape.py"):
            with self.subTest(name=name),self.assertRaises(PatchDenied):
                inspect_patch(self.root,self.proposal(path=name,existing=False))

    def test_symlink_destination_denied(self):
        link=self.root/PREFIX/"sym.py"
        link.symlink_to(self.target)
        with self.assertRaises(PatchDenied):
            inspect_patch(self.root,self.proposal(path=PREFIX+"sym.py",existing=False))

    def test_dynamic_code_execution_causes_blocked_review(self):
        dangerous=b"def bad(source):\n    exec(source)\n"
        report=inspect_patch(self.root,self.proposal(body=dangerous))
        self.assertIn("DYNAMIC_CODE_EXECUTION",report["issues"])
        self.assertFalse(report["local_static_checks_pass"])

    def test_invalid_python_cannot_be_approved(self):
        report=inspect_patch(self.root,self.proposal(body=b"def invalid( :"))
        self.assertIn("INVALID_PYTHON_SYNTAX",report["issues"])

    def test_bad_base64_and_duplicate_files_denied(self):
        proposal=self.proposal()
        proposal["changes"][0]["content_base64"]="!!!!!"
        with self.assertRaises(PatchDenied):
            inspect_patch(self.root,proposal)
        proposal=self.proposal()
        proposal["changes"].append(dict(proposal["changes"][0]))
        with self.assertRaises(PatchDenied):
            inspect_patch(self.root,proposal)

    def test_new_campaign_file_only_with_explicit_null_base(self):
        name=PREFIX+"new_module.py"
        result=inspect_patch(self.root,self.proposal(path=name,existing=False))
        self.assertTrue(result["local_static_checks_pass"])
        self.assertFalse((self.root/name).exists())

    def test_embedded_private_key_content_is_blocked_without_exposure(self):
        blob=("-----BEGIN "+"PRIVATE KEY-----").encode()+b"\n"+"FAKE_TEST_ONLY".encode()
        result=inspect_patch(self.root,self.proposal(body=blob))
        self.assertIn("PRIVATE_KEY",result["issues"])
        self.assertNotIn("FAKE_TEST_ONLY",json.dumps(result))


class SupplyChainTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.root=Path(tmp.name)
        (self.root/"code").mkdir()

    def test_valid_source_has_no_blockers(self):
        f=self.root/"code/good.py";f.write_text("print('hello')\n")
        scan=scan_changed(self.root,["code/good.py"])
        self.assertEqual(scan["blocking_rules"],0)
        self.assertFalse(scan["release_authorized"])

    def test_realistic_high_confidence_tokens_are_redacted(self):
        token="sk-"+"proj-"+("A"*40)
        p=self.root/"code/leak.py";p.write_text("key='"+token+"'\n")
        report=scan_changed(self.root,["code/leak.py"])
        self.assertEqual(report["blocking_rules"],1)
        self.assertNotIn(token,json.dumps(report))
        self.assertEqual(report["issues"][0]["path"],"code/leak.py")

    def test_private_key_header_and_filename_detection(self):
        p=self.root/"code/.env.prod"
        p.write_text("-----BEGIN "+"PRIVATE KEY-----")
        report=scan_changed(self.root,["code/.env.prod"])
        self.assertGreaterEqual(report["blocking_rules"],2)
        self.assertIn("PRIVATE_KEY",{x["rule"] for x in report["issues"]})

    def test_floating_node_package_flagged_as_warning(self):
        f=self.root/"code/package.json"
        f.write_text(json.dumps({"dependencies":{"lib":"^1.3.0","other":"2.4.1"}}))
        report=scan_changed(self.root,["code/package.json"])
        self.assertEqual(report["blocking_rules"],0)
        self.assertIn("FLOATING_NODE_DEPENDENCY",{x["rule"] for x in report["issues"]})

    def test_malformed_manifest_is_blocker(self):
        f=self.root/"code/package.json"
        f.write_text("{bad")
        report=scan_changed(self.root,["code/package.json"])
        self.assertIn("UNPARSEABLE_PACKAGE_JSON",{x["rule"] for x in report["issues"]})
        self.assertEqual(report["blocking_rules"],1)

    def test_missing_changed_file_warns_not_claims_scanned(self):
        report=scan_changed(self.root,["code/missing.py"])
        self.assertEqual(report["scanned"],0)
        self.assertIn("REMOVED_FILE_NOT_INSPECTED",{i["rule"] for i in report["issues"]})

    def test_symlink_and_traversal_fail_closed(self):
        link=self.root/"code/linked"
        link.symlink_to(self.root/"code/good.py")
        with self.assertRaises(ScanDenied):
            scan_changed(self.root,["code/linked"])
        with self.assertRaises(ScanDenied):
            scan_changed(self.root,["../secret"])

    def test_requirements_unpinned_warned(self):
        f=self.root/"code/requirements.txt"
        f.write_text("pytest>=8\nrequests==2.32.1\n")
        report=scan_changed(self.root,["code/requirements.txt"])
        self.assertIn("UNPINNED_PYTHON_DEPENDENCY",{i["rule"] for i in report["issues"]})
        self.assertFalse(report["license_provenance_verified"])

    def test_scanner_does_not_emit_secret_value(self):
        token="gh"+"p_"+("B"*36)
        report=scan_content("code/x.py",("t='"+token+"'").encode())
        self.assertEqual(report[0]["rule"],"GITHUB_PAT")
        self.assertNotIn(token,json.dumps(report))


if __name__=="__main__":
    unittest.main()
