"""Wave 27 real runnable preview package and offline QA evidence tests."""
from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

from campaign180.local_preview_bundle import (
    ROOTNAME,PreviewBundleDenied,build,smoke,verify,
)

SOURCE=Path(__file__).resolve().parents[1]
REVISION="b"*40


class BundleTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix="osgard-wave27-")
        self.addCleanup(temp.cleanup)
        self.root=Path(temp.name)
        self.archive=self.root/"preview.zip"

    def build_valid(self):
        result=build(SOURCE,self.archive,REVISION)
        self.assertEqual(result["revision"],REVISION)
        self.assertTrue(result["verified"])
        return result

    def test_full_preview_zip_is_real_and_manifested(self):
        summary=self.build_valid()
        self.assertGreater(summary["file_count"],45)
        self.assertFalse(summary["production_authorized"])
        with zipfile.ZipFile(self.archive) as z:
            names=set(z.namelist())
            for entry in (
                ROOTNAME+"/campaign180/local_http.py",
                ROOTNAME+"/campaign180/preview_launcher.py",
                ROOTNAME+"/campaign180/scenario_monitoring.py",
                ROOTNAME+"/assets/index.html",
                ROOTNAME+"/assets/console.js",
                ROOTNAME+"/run_local.py",
                ROOTNAME+"/README_RU.md",
            ):
                self.assertIn(entry,names)
            self.assertFalse(any("local-data/" in x or x.endswith(".sqlite3")
                                 or "/.env" in x or "/__pycache__/" in x
                                 for x in names))
            m=json.loads(z.read(ROOTNAME+"/CHECKSUMS.json"))
            self.assertEqual(m["independently_accepted_original_tasks"],0)
            self.assertEqual(m["revision"],REVISION)

    def test_zip_is_byte_identical_across_independent_builds(self):
        self.build_valid()
        alternate=self.root/"alternate.zip"
        build(SOURCE,alternate,REVISION)
        self.assertEqual(self.archive.read_bytes(),alternate.read_bytes())

    def test_extracted_zip_passes_actual_authenticated_sqlite_http_smoke(self):
        self.build_valid()
        report=smoke(self.archive)
        self.assertEqual(report["smoke"],"PASS")
        self.assertFalse(report["public_server_started"])

    def test_existing_output_refuses_overwrite(self):
        self.build_valid()
        current=sha256(self.archive.read_bytes()).hexdigest()
        with self.assertRaises(PreviewBundleDenied):
            build(SOURCE,self.archive,REVISION)
        self.assertEqual(sha256(self.archive.read_bytes()).hexdigest(),current)

    def test_bad_revision_is_rejected(self):
        for revision in ("main","0"*39,"z"*40,123):
            with self.subTest(revision=revision):
                with self.assertRaises(PreviewBundleDenied):
                    build(SOURCE,self.archive,revision)
        self.assertFalse(self.archive.exists())

    def test_corrupted_member_detected_against_manifest(self):
        self.build_valid()
        altered=self.root/"modified.zip"
        with zipfile.ZipFile(self.archive) as src,zipfile.ZipFile(altered,"w") as out:
            for info in src.infolist():
                content=src.read(info.filename)
                if info.filename==ROOTNAME+"/assets/console.js":
                    content+=b"\n// corrupted source\n"
                out.writestr(info,content)
        with self.assertRaises(PreviewBundleDenied):
            verify(altered)

    def test_extra_unmanifested_path_is_rejected(self):
        self.build_valid()
        extra=self.root/"extra.zip"
        with zipfile.ZipFile(self.archive) as src,zipfile.ZipFile(extra,"w") as out:
            for info in src.infolist():
                out.writestr(info,src.read(info.filename))
            out.writestr(ROOTNAME+"/unexpected.txt",b"not in checksums")
        with self.assertRaises(PreviewBundleDenied):
            verify(extra)

    def test_zip_path_traversal_rejected_before_extraction(self):
        self.build_valid()
        bad=self.root/"traversal.zip"
        with zipfile.ZipFile(self.archive) as src,zipfile.ZipFile(bad,"w") as out:
            for info in src.infolist():
                out.writestr(info,src.read(info.filename))
            out.writestr(ROOTNAME+"/../escape.txt",b"malicious")
        with self.assertRaises(PreviewBundleDenied):
            verify(bad)

    def test_invalid_zip_is_rejected(self):
        self.archive.write_bytes(b"not a real archive")
        with self.assertRaises(PreviewBundleDenied):
            verify(self.archive)

    @unittest.skipIf(shutil.which("node") is None,"Node.js not available")
    def test_offline_qa_gallery_uses_only_real_png_and_verified_log(self):
        gallery=self.root/"evidence"
        gallery.mkdir()
        # Valid minimal PNG bytes for source-file validation only.
        (gallery/"01-example-desktop.png").write_bytes(
            bytes([137,80,78,71,13,10,26,10])+b"X"*110)
        script=SOURCE/"tests"/"build-qa-gallery.mjs"
        expected={
            "browser":"Chromium","flows":["real-api","mobile-390"],
            "screenshots":1,"console_exceptions":0,
            "horizontal_overflow":0,"production_deployed":False,
        }
        (gallery/"acceptance.log").write_text(
            "BROWSER_ACCEPTANCE_SUCCESS "+json.dumps(expected)+"\n",
            encoding="utf-8")
        process=subprocess.run(["node",str(script),str(gallery)],
                               capture_output=True,text=True,timeout=20)
        self.assertEqual(process.returncode,0,process.stderr)
        out=json.loads((gallery/"QA_RESULTS.json").read_text(encoding="utf-8"))
        self.assertTrue(out["verified_chromium"])
        self.assertEqual(out["screenshot_count"],1)
        self.assertEqual(out["test_flow_count"],2)
        self.assertIn("OSGARD", (gallery/"index.html").read_text(encoding="utf-8"))

    @unittest.skipIf(shutil.which("node") is None,"Node.js not available")
    def test_gallery_fails_closed_without_real_acceptance_evidence(self):
        gallery=self.root/"evidence-fail"
        gallery.mkdir()
        (gallery/"01-example-desktop.png").write_bytes(
            bytes([137,80,78,71,13,10,26,10])+b"X"*110)
        result=subprocess.run(
            ["node",str(SOURCE/"tests"/"build-qa-gallery.mjs"),str(gallery)],
            capture_output=True,text=True,timeout=20)
        self.assertNotEqual(result.returncode,0)
        q=json.loads((gallery/"QA_RESULTS.json").read_text(encoding="utf-8"))
        self.assertFalse(q["verified_chromium"])


if __name__=="__main__":
    unittest.main()
