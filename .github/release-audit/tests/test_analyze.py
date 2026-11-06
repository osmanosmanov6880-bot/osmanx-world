"""Local Git fixtures for full-history PR boundary and split registry."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from analyze import BoundaryError, audit, parse_name_status, valid_path


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Offline QA")
        self.git("config", "user.email", "offline-qa@example.invalid")
        self.put("README.md", "baseline")
        self.commit("initial")
        self.base = self.sha()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo).decode().strip()

    def put(self, path, content="fixture"):
        name = self.repo / path
        name.parent.mkdir(parents=True, exist_ok=True)
        name.write_text(content, encoding="utf-8")

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-qm", message)

    def sha(self):
        return self.git("rev-parse", "HEAD")

    def test_isolated_review_scope_not_a_release_pass(self):
        self.put(".github/release-audit/analyze.py", "print('ok')\n")
        self.put(".github/workflows/osgard-pr-boundary.yml", "name: audit\n")
        self.commit("single scope")
        result = audit(self.repo, self.base, self.sha())
        self.assertTrue(result["eligible_for_isolated_nonproduction_review"])
        self.assertEqual(result["change_count"], 2)
        self.assertEqual(list(result["scopes"]), ["release-audit"])
        self.assertFalse(result["merge_authorized"])
        self.assertFalse(result["production_authorized"])

    def test_protected_earlier_commit_not_hidden_by_clean_tip(self):
        self.put("supreme-director/originals/DIRECTOR_MASTER_180.md")
        self.commit("protected")
        self.put(".github/release-audit/note.md")
        self.commit("clean tip")
        result = audit(self.repo, self.base, self.sha())
        self.assertIn("PROTECTED_ORIGINAL_CHANGE", result["policy_flags"])
        self.assertIn("MIXED_WORKSTREAMS_REQUIRES_SPLIT", result["policy_flags"])
        self.assertEqual(result["diff_scope"], "MERGE_BASE_TO_HEAD_ALL_COMMITS")

    def test_module_batch_requires_split(self):
        self.put("supreme-director/m189/core.py")
        self.put("supreme-director/m190/ledger.py")
        self.commit("modules")
        result = audit(self.repo, self.base, self.sha())
        self.assertIn("MIXED_WORKSTREAMS_REQUIRES_SPLIT", result["policy_flags"])
        self.assertEqual(sorted(result["scopes"]), ["m189", "m190"])

    def test_deleted_protected_file_detected(self):
        self.put("supreme-director/recovery/status.json")
        self.commit("baseline")
        before = self.sha()
        (self.repo / "supreme-director/recovery/status.json").unlink()
        self.commit("delete")
        result = audit(self.repo, before, self.sha())
        self.assertIn("PROTECTED_ORIGINAL_CHANGE", result["policy_flags"])
        self.assertEqual(result["scopes"]["held-originals"]["changes"][0]["status"], "D")

    def test_rename_checks_original_and_destination(self):
        self.put("supreme-director/local-kit/originals/master.md", "master")
        self.commit("baseline")
        before = self.sha()
        self.git("mv", "supreme-director/local-kit/originals/master.md", "README_MOVED.md")
        self.commit("rename")
        result = audit(self.repo, before, self.sha())
        self.assertIn("PROTECTED_ORIGINAL_CHANGE", result["policy_flags"])
        self.assertTrue(any(item["old_path"] == "supreme-director/local-kit/originals/master.md"
                            for item in result["scopes"]["held-originals"]["changes"]))

    def test_nested_secret_is_blocked(self):
        self.put("configs/.env.production", "DUMMY")
        self.commit("sensitive")
        self.assertIn("SENSITIVE_PATH_CHANGE", audit(self.repo, self.base, self.sha())["policy_flags"])

    def test_source_change_not_self_authorized(self):
        self.put("sources/TITAN/service.py")
        self.commit("source")
        result = audit(self.repo, self.base, self.sha())
        self.assertIn("UNVERIFIED_UPSTREAM_SOURCE_CHANGE", result["policy_flags"])
        self.assertIn("held-source-titan", result["scopes"])

    def test_nul_delimited_rename_and_spaces(self):
        result = parse_name_status(b"R100\0old name.py\0new name.py\0M\0a b.py\0")
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["old_path"], "old name.py")
        self.assertEqual(result[0]["new_path"], "new name.py")
        self.assertEqual(result[1]["new_path"], "a b.py")

    def test_malformed_paths_and_streams_refused(self):
        for path in ("../escape", "a//b", "./x", "/root", "a\\b", "a/\nfile"):
            with self.subTest(path=repr(path)):
                with self.assertRaises(BoundaryError):
                    valid_path(path)
        for raw in (b"R100\0only-old\0", b"M\0missing-terminal", b"XBAD\0a\0"):
            with self.subTest(raw=raw):
                with self.assertRaises(BoundaryError):
                    parse_name_status(raw)

    def test_refs_must_be_full_commit_sha(self):
        with self.assertRaises(BoundaryError):
            audit(self.repo, "--upload-pack=evil", self.sha())

    def test_empty_diff_is_no_go(self):
        result = audit(self.repo, self.base, self.base)
        self.assertIn("EMPTY_PULL_REQUEST_DIFF", result["policy_flags"])

    def test_same_diff_has_stable_fingerprint(self):
        self.put(".github/release-audit/README.md", "proof")
        self.commit("fixture")
        a = audit(self.repo, self.base, self.sha())
        b = audit(self.repo, self.base, self.sha())
        self.assertEqual(a["change_set_sha256"], b["change_set_sha256"])
        self.assertEqual(a, b)

    def test_sensitive_deletion_detected(self):
        self.put("private/secret.key")
        self.commit("baseline")
        before = self.sha()
        (self.repo / "private/secret.key").unlink()
        self.commit("delete")
        self.assertIn("SENSITIVE_PATH_CHANGE", audit(self.repo, before, self.sha())["policy_flags"])


if __name__ == "__main__":
    unittest.main()
