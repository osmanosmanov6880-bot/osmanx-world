"""Offline adversarial tests for M191 backup/restore against real M190 SQLite."""
from __future__ import annotations

from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from m190 import ledger
from m191 import recovery

PLAN = Path(__file__).resolve().parents[2] / "recovery" / "ORIGINAL_180_TASKS.json"


def report_data():
    tasks = json.loads(PLAN.read_text(encoding="utf-8"))["tasks"]
    return {
        "schema": "osgard.m189.admission-report/1",
        "original_task_acceptance": 0,
        "verified_production_upstreams": 0,
        "production_authorized": False,
        "release_gate": "NO_GO",
        "signed_local_evidence_ready": 0,
        "statuses": {"BLOCKED_UPSTREAM": 180},
        "tasks": [{"id": t["id"], "team": t["team"], "priority": t["priority"],
                   "depends_on": t["explicit_deps"], "status": "BLOCKED_UPSTREAM",
                   "reason": "MISSING_CANONICAL_SOURCE"} for t in tasks],
    }


class M191RecoveryTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.db = self.root / "journal.sqlite"
        self.anchor = self.root / "trusted-head.json"
        self.bundle = self.root / "recovery-bundle"
        self.out_db = self.root / "restored.sqlite"
        self.report = self.root / "report.json"
        self.report.write_text(json.dumps(report_data(), sort_keys=True), encoding="utf-8")
        result = ledger.create(self.db, PLAN)
        ledger.ingest(self.db, plan_path=PLAN, report_path=self.report,
                      actor="synthetic-operator", expected_head=result["head"])
        ledger.write_anchor(self.db, self.anchor)

    def backup(self):
        return recovery.create_backup(self.db, self.anchor, self.bundle)

    def test_backup_verified(self):
        summary = self.backup()
        self.assertEqual(summary["result"], "PASS_LOCAL_ONLY")
        self.assertEqual(summary["events"], 1)
        self.assertEqual(summary["release_gate"], "NO_GO")
        self.assertFalse(summary["production_authorized"])
        self.assertTrue(summary["externally_anchored"])

    def test_restore_independent_db_and_history(self):
        self.backup()
        res = recovery.restore_backup(self.bundle, self.anchor, self.out_db)
        self.assertTrue(res["new_database_created"])
        self.assertEqual(ledger.verify_anchor(self.out_db, self.anchor)["events"], 1)
        self.assertEqual(res["head"], ledger.verify(self.db)["head"])
        self.assertNotEqual(self.out_db, self.db)

    def test_restore_notes_preserved(self):
        head = ledger.verify(self.db)["head"]
        ledger.add_note(self.db, task_id="TITAN-X01", actor="synthetic-operator",
                        message="One further note", expected_head=head)
        ledger.write_anchor(self.db, self.anchor)
        self.backup()
        recovery.restore_backup(self.bundle, self.anchor, self.out_db)
        result = ledger.verify_anchor(self.out_db, self.anchor)
        self.assertEqual((result["events"], result["notes"]), (2, 1))
        self.assertEqual(result["status_counts"], {"BLOCKED_UPSTREAM": 180})

    def test_backup_refuses_overwrite(self):
        self.backup()
        with self.assertRaisesRegex(recovery.RecoveryError, "already exists"):
            self.backup()

    def test_restore_refuses_overwrite(self):
        self.backup()
        self.out_db.write_text("unrelated existing database")
        with self.assertRaisesRegex(recovery.RecoveryError, "already exists"):
            recovery.restore_backup(self.bundle, self.anchor, self.out_db)
        self.assertEqual(self.out_db.read_text(), "unrelated existing database")

    def test_backup_external_anchor_is_mandatory(self):
        self.anchor.unlink()
        with self.assertRaises(recovery.RecoveryError):
            self.backup()
        self.assertFalse(self.bundle.exists())

    def test_wrong_anchor_cannot_verify_backup(self):
        self.backup()
        tampered = json.loads(self.anchor.read_text())
        tampered["head"] = "f" * 64
        self.anchor.write_text(json.dumps(tampered))
        with self.assertRaises(recovery.RecoveryError):
            recovery.verify_bundle(self.bundle, self.anchor)

    def test_backup_rejects_stale_anchor_after_event(self):
        head = ledger.verify(self.db)["head"]
        ledger.add_note(self.db, task_id="TITAN-X01", actor="synthetic-operator",
                        message="anchor not updated", expected_head=head)
        with self.assertRaises((ledger.LedgerError, recovery.RecoveryError)):
            self.backup()
        self.assertFalse(self.bundle.exists())

    def test_tampered_backup_byte_detected(self):
        self.backup()
        with (self.bundle / "ledger.sqlite").open("ab") as f:
            f.write(b"MALICIOUS_TRAILING_BYTES")
        with self.assertRaisesRegex(recovery.RecoveryError, "byte SHA-256 mismatch"):
            recovery.verify_bundle(self.bundle, self.anchor)

    def test_corrupt_manifest_rejected(self):
        self.backup()
        (self.bundle / "manifest.json").write_text("{}")
        with self.assertRaisesRegex(recovery.RecoveryError, "manifest schema"):
            recovery.verify_bundle(self.bundle, self.anchor)

    def test_manifest_cannot_claim_production(self):
        self.backup()
        p = self.bundle / "manifest.json"
        m = json.loads(p.read_text())
        m["production_authorized"] = True
        p.write_text(json.dumps(m))
        with self.assertRaisesRegex(recovery.RecoveryError, "production"):
            recovery.verify_bundle(self.bundle, self.anchor)

    def test_extra_files_in_bundle_rejected(self):
        self.backup()
        (self.bundle / "unexpected.txt").write_text("extra")
        with self.assertRaisesRegex(recovery.RecoveryError, "layout"):
            recovery.verify_bundle(self.bundle, self.anchor)

    def test_missing_manifest_rejected(self):
        self.backup()
        (self.bundle / "manifest.json").unlink()
        with self.assertRaises(recovery.RecoveryError):
            recovery.verify_bundle(self.bundle, self.anchor)

    def test_symlinked_external_anchor_refused(self):
        actual = self.anchor
        symlink = self.root / "fake-anchor.json"
        try:
            symlink.symlink_to(actual)
        except (OSError, NotImplementedError):
            self.skipTest("Symlink creation unavailable")
        with self.assertRaisesRegex(recovery.RecoveryError, "symlinked"):
            recovery.create_backup(self.db, symlink, self.bundle)

    def test_symlinked_source_db_refused(self):
        alias = self.root / "fake-source.sqlite"
        try:
            alias.symlink_to(self.db)
        except (OSError, NotImplementedError):
            self.skipTest("Symlink creation unavailable")
        with self.assertRaisesRegex(recovery.RecoveryError, "symlinked"):
            recovery.create_backup(alias, self.anchor, self.bundle)

    def test_symlinked_backup_bundle_refused(self):
        self.backup()
        alias = self.root / "fake-backup"
        try:
            alias.symlink_to(self.bundle, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("Symlink creation unavailable")
        with self.assertRaisesRegex(recovery.RecoveryError, "symlinked"):
            recovery.verify_bundle(alias, self.anchor)

    def test_external_anchor_cannot_live_inside_bundle(self):
        self.backup()
        hidden = self.bundle / "some-anchor.json"
        hidden.write_bytes(self.anchor.read_bytes())
        with self.assertRaisesRegex(recovery.RecoveryError, "OUTSIDE"):
            recovery.verify_bundle(self.bundle, hidden)

    def test_backup_crash_after_snapshot_is_cleaned(self):
        with self.assertRaisesRegex(recovery.RecoveryError, "INJECTED_FAILURE_AFTER_SNAPSHOT"):
            recovery.create_backup(self.db, self.anchor, self.bundle,
                                   inject_failure="after_snapshot")
        self.assertFalse(self.bundle.exists())
        self.assertFalse(list(self.root.glob(".m191-staging-*")))
        self.assertEqual(ledger.verify_anchor(self.db, self.anchor)["events"], 1)

    def test_backup_crash_before_publish_is_cleaned(self):
        with self.assertRaisesRegex(recovery.RecoveryError, "INJECTED_FAILURE_BEFORE_PUBLISH"):
            recovery.create_backup(self.db, self.anchor, self.bundle,
                                   inject_failure="before_publish")
        self.assertFalse(self.bundle.exists())
        self.assertFalse(list(self.root.glob(".m191-staging-*")))

    def test_restore_crash_after_copy_is_cleaned(self):
        self.backup()
        with self.assertRaisesRegex(recovery.RecoveryError, "INJECTED_FAILURE_AFTER_COPY"):
            recovery.restore_backup(self.bundle, self.anchor, self.out_db,
                                    inject_failure="after_copy")
        self.assertFalse(self.out_db.exists())
        self.assertFalse(list(self.root.glob(".m191-restore-*")))

    def test_restore_crash_before_publish_is_cleaned(self):
        self.backup()
        with self.assertRaisesRegex(recovery.RecoveryError, "INJECTED_FAILURE_BEFORE_PUBLISH"):
            recovery.restore_backup(self.bundle, self.anchor, self.out_db,
                                    inject_failure="before_publish")
        self.assertFalse(self.out_db.exists())

    def test_preexisting_parent_symlink_refused(self):
        self.backup()
        realdir = self.root / "actual"
        realdir.mkdir()
        alias = self.root / "link-to-actual"
        try:
            alias.symlink_to(realdir, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("Symlink creation unavailable")
        with self.assertRaises(recovery.RecoveryError):
            recovery.restore_backup(self.bundle, self.anchor, alias / "restored.sqlite")

    def test_verify_anchor_independent_directory(self):
        self.backup()
        newroot = self.root / "independent"
        newroot.mkdir()
        moved = newroot / "anchor.json"
        moved.write_bytes(self.anchor.read_bytes())
        result = recovery.verify_bundle(self.bundle, moved)
        self.assertEqual(result["events"], 1)

    def test_multiple_restore_targets_supported(self):
        self.backup()
        recovery.restore_backup(self.bundle, self.anchor, self.out_db)
        additional = self.root / "second.sqlite"
        recovery.restore_backup(self.bundle, self.anchor, additional)
        self.assertEqual(ledger.verify_anchor(additional, self.anchor)["head"],
                         ledger.verify_anchor(self.out_db, self.anchor)["head"])

    def test_cli_backup_verify_restore(self):
        cwd = Path(__file__).resolve().parents[2]
        cmds = [["backup", "--db", str(self.db), "--anchor", str(self.anchor),
                 "--bundle", str(self.bundle)],
                ["verify", "--bundle", str(self.bundle), "--anchor", str(self.anchor)],
                ["restore", "--bundle", str(self.bundle), "--anchor", str(self.anchor),
                 "--out-db", str(self.out_db)]]
        for args in cmds:
            p = subprocess.run([sys.executable, "-m", "m191", *args],
                               cwd=cwd, capture_output=True, text=True, timeout=20)
            self.assertEqual(p.returncode, 0, p.stderr)
            data = json.loads(p.stdout)
            self.assertEqual(data["release_gate"], "NO_GO")
        self.assertTrue(self.out_db.exists())

    def test_cli_refuses_existing_target(self):
        self.backup()
        self.out_db.write_text("do not delete")
        cwd = Path(__file__).resolve().parents[2]
        p = subprocess.run([sys.executable, "-m", "m191", "restore",
                            "--bundle", str(self.bundle), "--anchor", str(self.anchor),
                            "--out-db", str(self.out_db)],
                           cwd=cwd, capture_output=True, text=True, timeout=20)
        self.assertEqual(p.returncode, 2)
        self.assertIn("NO_GO", p.stderr)
        self.assertEqual(self.out_db.read_text(), "do not delete")


if __name__ == "__main__":
    unittest.main()
