"""Direct tests for original TITAN-X01 through TITAN-X05 ONLY.

Actual connected upstream KRAKEN/DevSwarm/Command URLs and owner approval
are absent, so these tests MUST NOT grant independent product acceptance.
All remote operations disabled; wheel packages use synthesized stdlib files.
"""
import base64
import csv
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

from campaign180.registry import EvidenceError,load_original
from campaign180.titan_baseline import snapshot
from campaign180.titan_dependencies import inventory
from campaign180.titan_codeowners import inspect_changes
from campaign180.titan_artifacts import (
    verify_reproducible_signed,public_key_fingerprint,ArtifactDenied
)
from campaign180.repro import build_package,sign_package
from campaign180.offline_deps import (
    inspect_offline_wheelhouse,restore_into_empty_target,DependencyError,
)

ROOT=Path(__file__).resolve().parents[3]

def git(*args):
    subprocess.run(["git",*map(str,args)],check=True,capture_output=True)

def fixture(root:Path):
    git("init","-q",root)
    (root/".github").mkdir()
    shutil.copyfile(ROOT/".github/CODEOWNERS",root/".github/CODEOWNERS")
    data=root/"supreme-director/campaign180/data"
    data.mkdir(parents=True)
    shutil.copyfile(ROOT/"supreme-director/campaign180/data/UPSTREAM_REGISTRY.json",
                    data/"UPSTREAM_REGISTRY.json")
    (root/"README.md").write_text("local fixture\n")
    git("-C",root,"add",".")
    git("-C",root,"-c","user.name=TITAN Test",
        "-c","user.email=titan-test@example.invalid","commit","-qm","baseline")

def commit(root:Path):
    git("-C",root,"add",".")
    git("-C",root,"-c","user.name=TITAN Test",
        "-c","user.email=titan-test@example.invalid","commit","-qm","change")

class OriginalFirstFiveTests(unittest.TestCase):
    def test_exact_original_first_five_not_new_random_tasks(self):
        original=load_original(ROOT)
        self.assertEqual([x["id"] for x in original["tasks"][:5]],
                         [f"TITAN-X{i:02d}" for i in range(1,6)])

    def test_x01_immutable_sha_tree_but_source_blocked(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);fixture(root)
            report=snapshot(root)
            self.assertEqual(report["task_id"],"TITAN-X01")
            self.assertRegex(report["checkout_commit"],r"^[0-9a-f]{40}$")
            self.assertRegex(report["checkout_tree"],r"^[0-9a-f]{40}$")
            self.assertFalse(report["source_dirty"])
            self.assertEqual(report["status"],"BLOCKED_UPSTREAM")
            self.assertIn("UPSTREAM_OWNER_APPROVAL_MISSING",report["blockers"])
            self.assertFalse(report["independently_accepted"])

    def test_x01_dirtied_tracked_source_detected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);fixture(root)
            (root/"README.md").write_text("changed without commit")
            result=snapshot(root)
            self.assertTrue(result["source_dirty"])
            self.assertIn("TRACKED_WORKTREE_DIRTY",result["blockers"])

    def test_x01_private_origin_credentials_not_disclosed(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);fixture(root)
            git("-C",root,"remote","add","origin",
                "https://secret-user:super-secret@github.com/org/repo.git")
            report=snapshot(root)
            self.assertIsNone(report["origin_normalized"])
            self.assertNotIn("super-secret",json.dumps(report))

    def test_x02_reads_real_pyproject_package_and_lock_gaps(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);fixture(root)
            work=root/"kitchen";work.mkdir()
            (work/"pyproject.toml").write_text(
                '[project]\nname="kitchen"\nversion="1.0.0"\n'
                'dependencies=["pytest>=8","httpx==0.27.0"]\n')
            commit(root)
            result=inventory(root)
            record=next(x for x in result["manifests"] if x["path"]=="kitchen/pyproject.toml")
            self.assertIn("pytest>=8",record["dependencies"])
            self.assertIn("DECLARED_DEPENDENCIES_WITHOUT_LOCKFILE",record["risks"])
            self.assertIn("UNLOCKED_OR_FLOATING_PYTHON_DEPENDENCY",record["risks"])
            self.assertFalse(result["network_access"])
            self.assertEqual(result["status"],"BLOCKED_UPSTREAM")

    def test_x02_unpinned_node_deps_and_missing_lock(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);fixture(root)
            (root/"package.json").write_text(json.dumps({
                "name":"fixture","version":"0.1.0",
                "dependencies":{"react":"^19.0.0","safe":"1.0.1"}}))
            commit(root)
            x=inventory(root)
            n=next(r for r in x["manifests"] if r["path"]=="package.json")
            self.assertIn("FLOATING_NODE_DEPENDENCY",n["risks"])
            self.assertIn("DECLARED_DEPENDENCIES_WITHOUT_LOCKFILE",n["risks"])

    def test_x02_refuses_symlinked_package_metadata(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);fixture(root)
            outside=root/"original.json"
            outside.write_text('{"name":"valid"}')
            (root/"package.json").symlink_to(outside)
            commit(root)
            with self.assertRaises(EvidenceError):
                inventory(root)

    def test_x03_effective_codeowner_and_local_change(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);fixture(root)
            x=inspect_changes(root,["supreme-director/campaign180/campaign180/registry.py"])
            self.assertEqual(x["task_id"],"TITAN-X03")
            self.assertEqual(x["decisions"][0]["final_owners"],
                             ["@osmanosmanov6880-bot"])
            self.assertTrue(x["local_changes_admissible"])
            self.assertFalse(x["independent_reviewer_approval"])

    def test_x03_conflicting_team_and_original_paths_block(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);fixture(root)
            x=inspect_changes(root,["sources/TITAN/engine.py","sources/NEXUS/engine.py",
                                    "supreme-director/originals/DIRECTOR_MASTER_180.md"])
            self.assertIn("CROSS_TEAM_WRITE_WITHOUT_INDEPENDENT_REVIEW",x["change_issues"])
            self.assertIn("ORIGINAL_SOURCE_MODIFICATION_REQUIRES_OWNER_REVIEW",x["change_issues"])
            self.assertFalse(x["local_changes_admissible"])

    def test_x03_cannot_hide_invalid_diff_paths(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);fixture(root)
            for candidate in ("../escape","/absolute","a\\other","a//b"):
                with self.subTest(path=candidate),self.assertRaises(EvidenceError):
                    inspect_changes(root,[candidate])

    @unittest.skipUnless(shutil.which("openssl"),"Real Ed25519 OpenSSL required")
    def test_x04_rebuild_and_sign_with_trusted_fingerprint(self):
        with tempfile.TemporaryDirectory() as d:
            tmp=Path(d)
            private=tmp/"sign.key";public=tmp/"verify.pub"
            subprocess.run(["openssl","genpkey","-algorithm","ed25519",
                            "-out",str(private)],check=True,capture_output=True)
            subprocess.run(["openssl","pkey","-in",str(private),"-pubout",
                            "-out",str(public)],check=True,capture_output=True)
            blob=build_package(ROOT)
            signature=sign_package(blob,private_key=private)
            fingerprint=public_key_fingerprint(public)
            data=verify_reproducible_signed(ROOT,blob,signature,
                public_key=public,expected_key_sha256=fingerprint)
            self.assertTrue(data["signature_valid"])
            self.assertTrue(data["byte_reproduced_twice"])
            self.assertEqual(data["status"],"BLOCKED_UPSTREAM")
            self.assertFalse(data["production_release_authorized"])
            with self.assertRaises(ArtifactDenied):
                verify_reproducible_signed(ROOT,blob,signature,
                    public_key=public,expected_key_sha256="0"*64)
            with self.assertRaises(ArtifactDenied):
                verify_reproducible_signed(ROOT,blob,signature[:-1]+b"X",
                    public_key=public,expected_key_sha256=fingerprint)

    @staticmethod
    def _trusted_offline_wheel(wheelhouse:Path,req:Path):
        name="osgard_p0_fixture"
        version="0.1.0"
        metadata_dir=f"{name}-{version}.dist-info"
        members={
            f"{name}/__init__.py":b'VALUE = "TITAN-X05-INSTALLED"\n',
            f"{metadata_dir}/METADATA":(
                f"Metadata-Version: 2.1\nName: osgard-p0-fixture\n"
                f"Version: {version}\nSummary: Synthetic offline CI package\n\n").encode(),
            f"{metadata_dir}/WHEEL":(
                "Wheel-Version: 1.0\nGenerator: osgard-test\n"
                "Root-Is-Purelib: true\nTag: py3-none-any\n").encode(),
        }
        record=[]
        for name_,data in members.items():
            encoded=base64.urlsafe_b64encode(sha256(data).digest()).rstrip(b"=").decode()
            record.append([name_,"sha256="+encoded,str(len(data))])
        record.append([f"{metadata_dir}/RECORD","",""])
        output=io.StringIO()
        writer=csv.writer(output,lineterminator="\n")
        writer.writerows(record)
        members[f"{metadata_dir}/RECORD"]=output.getvalue().encode()
        wheel=wheelhouse/f"{name}-{version}-py3-none-any.whl"
        with zipfile.ZipFile(wheel,"w",compression=zipfile.ZIP_STORED) as z:
            for f,body in sorted(members.items()):
                z.writestr(f,body)
        req.write_text(f"osgard-p0-fixture=={version} --hash=sha256:"
                       f"{sha256(wheel.read_bytes()).hexdigest()}\n")
        return wheel

    def test_x05_real_offline_wheel_install_and_import(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);wheelhouse=root/"wheelhouse";wheelhouse.mkdir()
            requirements=root/"requirements.lock";target=root/"installed"
            self._trusted_offline_wheel(wheelhouse,requirements)
            scanned=inspect_offline_wheelhouse(requirements,wheelhouse)
            self.assertEqual(len(scanned["offline_packages"]),1)
            old=os.environ.get("PIP_INDEX_URL")
            os.environ["PIP_INDEX_URL"]="https://invalid.example.invalid/index"
            try:
                report=restore_into_empty_target(requirements,wheelhouse,target)
            finally:
                if old is None:os.environ.pop("PIP_INDEX_URL",None)
                else:os.environ["PIP_INDEX_URL"]=old
            self.assertTrue(report["installed"])
            self.assertEqual(report["installed_packages_verified"],1)
            self.assertFalse(report["upstream_test_dependencies_restored"])
            proc=subprocess.run([sys.executable,"-I","-c",
                f"import sys;sys.path.insert(0,{str(target)!r});"
                "import osgard_p0_fixture;"
                "assert osgard_p0_fixture.VALUE == 'TITAN-X05-INSTALLED'"],
                capture_output=True,check=False,timeout=15)
            self.assertEqual(proc.returncode,0,proc.stderr.decode())

    def test_x05_rejects_changed_offline_wheel_before_install(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);wheelhouse=root/"wheelhouse";wheelhouse.mkdir()
            req=root/"requirements.lock"
            wheel=self._trusted_offline_wheel(wheelhouse,req)
            wheel.write_bytes(wheel.read_bytes()+b"tampered")
            with self.assertRaises(DependencyError):
                restore_into_empty_target(req,wheelhouse,root/"target")
            self.assertFalse((root/"target").exists())

if __name__=="__main__":
    unittest.main()
