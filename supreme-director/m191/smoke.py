"""Reproduce actual M189 -> M190 -> M191 offline backup/restore with no accepted tasks."""
from __future__ import annotations
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from m190 import ledger
from m191 import recovery


def run() -> int:
    with tempfile.TemporaryDirectory(prefix="osgard-m191-smoke-") as temp:
        root = Path(temp)
        plan = ROOT / "recovery" / "ORIGINAL_180_TASKS.json"
        m189 = ROOT / "m189"
        cmd = [sys.executable, str(m189 / "admission.py"),
               "--plan", str(plan), "--master", str(ROOT / "originals" / "DIRECTOR_MASTER_180.md"),
               "--upstreams", str(m189 / "data" / "M189_UPSTREAMS.json"),
               "--submissions", str(m189 / "data" / "M189_SUBMISSIONS.json"),
               "--trust", str(m189 / "data" / "M189_TRUST_KEYS.json"),
               "--workspace", str(root / "no-canonical-sources"),
               "--evidence-root", str(root / "no-evidence"),
               "--output", str(root / "m189-report.json")]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        assert proc.returncode == 0, proc.stderr
        report = json.loads((root / "m189-report.json").read_text())
        assert report["statuses"] == {"BLOCKED_UPSTREAM": 180}
        db = root / "journal.sqlite"
        genesis = ledger.create(db, plan)
        tracked = ledger.ingest(db, plan_path=plan, report_path=root / "m189-report.json",
                                actor="synthetic-auditor", expected_head=genesis["head"])
        ledger.add_note(db, task_id="TITAN-X01", message="Canonical upstream not confirmed",
                        actor="synthetic-auditor", expected_head=tracked["head"])
        anchor = root / "independently-retained-anchor.json"
        ledger.write_anchor(db, anchor)
        bundle = root / "offline-backup"
        created = recovery.create_backup(db, anchor, bundle)
        restored = recovery.restore_backup(bundle, anchor, root / "recovered.sqlite")
        require = lambda b: (_ for _ in ()).throw(AssertionError("M191 smoke failed")) if not b else None
        require(created["events"] == restored["events"] == 2)
        require(created["head"] == restored["head"])
        require(created["original_task_acceptance"] == 0)
        require(restored["production_authorized"] is False)
        require(ledger.verify_anchor(root / "recovered.sqlite", anchor)["status_counts"] ==
                {"BLOCKED_UPSTREAM": 180})
        print("M191_SMOKE_PASS: M189 -> M190 -> SQLite online backup -> anchored restore; 180 blocked / NO_GO")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
