"""X01: three independent real Git checkouts and Ed25519 authenticity tests."""
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from campaign180.contracts import canonical
from campaign180.registry import EvidenceError
from campaign180.titan_source_provenance import (
    COMPONENTS, SCHEMA, _public_key_fingerprint, verify_canonical_sources)

def cmd(*args):
    x=subprocess.run([str(a) for a in args],capture_output=True,check=True,timeout=15)
    return x.stdout.strip().decode("utf-8")

@unittest.skipUnless(shutil.which("git") and shutil.which("openssl"),
                     "Real git and OpenSSL Ed25519 needed")
class CanonicalX01Tests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.temp=Path(tmp.name)
        self.paths={}
        components={}
        for name in COMPONENTS:
            root=self.temp/name
            root.mkdir()
            cmd("git","init","-q","-b","main",root)
            (root/"src").mkdir()
            (root/"src"/"engine.py").write_text("component="+repr(name)+"\n")
            (root/"README.md").write_text("Fixture source "+name+"\n")
            cmd("git","-C",root,"add",".")
            cmd("git","-C",root,"-c","user.name=CI",
                "-c","user.email=ci@example.invalid","commit","-qm","source")
            url="https://github.com/fixture/"+name.lower()
            cmd("git","-C",root,"remote","add","origin",url)
            self.paths[name]=root
            components[name]={"repository_url":url,"branch":"main",
                "commit_sha":cmd("git","-C",root,"rev-parse","HEAD"),
                "tree_sha":cmd("git","-C",root,"rev-parse","HEAD^{tree}")}
        self.policy={"schema":SCHEMA,"approved_by":"owner-test",
            "independent_reviewer":"reviewer-test","components":components}
        self.private=self.temp/"private.pem"
        self.public=self.temp/"public.pem"
        cmd("openssl","genpkey","-algorithm","Ed25519","-out",self.private)
        cmd("openssl","pkey","-in",self.private,"-pubout","-out",self.public)
        self.fingerprint=_public_key_fingerprint(self.public)

    def sign(self,policy=None):
        blob=canonical(self.policy if policy is None else policy)
        message=self.temp/"message.sha256"
        signature=self.temp/"manifest.sig"
        message.write_bytes(sha256(blob).digest())
        cmd("openssl","pkeyutl","-sign","-rawin","-inkey",self.private,
            "-in",message,"-out",signature)
        return blob,signature.read_bytes()

    def verify(self,*,policy=None,paths=None,trust=None,signature=None):
        blob,sig=self.sign(policy)
        return verify_canonical_sources(
            self.paths if paths is None else paths,blob,
            sig if signature is None else signature,public_key=self.public,
            trusted_key_sha256=self.fingerprint if trust is None else trust)

    def test_x01_verified_three_real_commits_tree_blobs_and_signature(self):
        report=self.verify()
        self.assertTrue(report["source_bytes_verified"])
        self.assertTrue(report["policy_signature_valid"])
        self.assertFalse(report["independently_accepted"])
        self.assertFalse(report["production_authorized"])
        self.assertEqual(set(report["components"]),set(COMPONENTS))
        for source in report["components"].values():
            self.assertEqual(source["tracked_files"],2)
            self.assertEqual(source["source_files"],1)
            self.assertRegex(source["file_manifest_sha256"],r"^[a-f0-9]{64}$")

    def test_x01_tampered_signature_and_untrusted_key_denied(self):
        blob,sig=self.sign()
        forged=bytes([sig[0]^1])+sig[1:]
        with self.assertRaises(EvidenceError):
            verify_canonical_sources(self.paths,blob,forged,public_key=self.public,
                                      trusted_key_sha256=self.fingerprint)
        with self.assertRaises(EvidenceError):
            self.verify(trust="0"*64)

    def test_x01_unsigned_or_noncanonical_policy_denied(self):
        blob,sig=self.sign()
        with self.assertRaises(EvidenceError):
            verify_canonical_sources(self.paths,blob+b"\n",sig,public_key=self.public,
                                      trusted_key_sha256=self.fingerprint)
        payload=deepcopy(self.policy)
        payload["approved_by"]=payload["independent_reviewer"]
        with self.assertRaises(EvidenceError): self.verify(policy=payload)

    def test_x01_stale_commit_and_tree_denied(self):
        for field in ("commit_sha","tree_sha"):
            policy=deepcopy(self.policy)
            policy["components"]["KRAKEN"][field]="0"*40
            with self.subTest(field=field),self.assertRaises(EvidenceError):
                self.verify(policy=policy)

    def test_x01_changed_and_credential_bearing_remote_denied(self):
        root=self.paths["KRAKEN"]
        cmd("git","-C",root,"remote","set-url","origin",
            "https://user:secret@github.com/fixture/kraken.git")
        with self.assertRaises(EvidenceError): self.verify()
        cmd("git","-C",root,"remote","set-url","origin",
            "https://github.com/stranger/kraken")
        with self.assertRaises(EvidenceError): self.verify()

    def test_x01_dirty_and_staged_changes_denied(self):
        root=self.paths["DevSwarm"]
        (root/"src"/"engine.py").write_text("modified=True\n")
        with self.assertRaises(EvidenceError): self.verify()
        cmd("git","-C",root,"add","src/engine.py")
        with self.assertRaises(EvidenceError): self.verify()

    def test_x01_untracked_files_denied(self):
        (self.paths["Command"]/"danger.py").write_text("code=True\n")
        with self.assertRaises(EvidenceError): self.verify()

    def test_x01_distinct_sources_required(self):
        paths=dict(self.paths)
        paths["Command"]=paths["KRAKEN"]
        with self.assertRaises(EvidenceError): self.verify(paths=paths)
        policy=deepcopy(self.policy)
        policy["components"]["Command"]["repository_url"]=policy["components"]["KRAKEN"]["repository_url"]
        with self.assertRaises(EvidenceError): self.verify(policy=policy)

    def test_x01_missing_component_and_wrong_branch_denied(self):
        policy=deepcopy(self.policy)
        del policy["components"]["Command"]
        with self.assertRaises(EvidenceError): self.verify(policy=policy)
        policy=deepcopy(self.policy)
        policy["components"]["Command"]["branch"]="release"
        with self.assertRaises(EvidenceError): self.verify(policy=policy)

    def test_x01_detached_head_denied(self):
        cmd("git","-C",self.paths["KRAKEN"],"checkout","-q","--detach","HEAD")
        with self.assertRaises(EvidenceError): self.verify()

if __name__=="__main__":
    unittest.main()
