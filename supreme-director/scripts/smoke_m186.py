#!/usr/bin/env python3
"""Test M186's positive and fail-closed flows using a temporary synthetic SQLite DB."""
from __future__ import annotations
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1] / "local-kit"


def run_cli(db, evidence, *args):
    command = [sys.executable, "-m", "osgard_m186", *args, "--db", str(db), "--root", str(evidence)]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=18, check=False)
    if result.returncode:
        raise AssertionError(f"CLI exit={result.returncode}: {result.stderr.strip()[:300]}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError("CLI did not produce JSON") from exc


def main():
    with tempfile.TemporaryDirectory(prefix="osgard-m186-reference-") as dirname:
        base = pathlib.Path(dirname)
        db = base / "reference.sqlite3"
        evidence = base / "evidence"
        init = run_cli(db, evidence, "init")
        assert init["lab"]["production_authorized"] is False
        assert init["lab"]["status"] == "REFERENCE_LAB_INITIALIZED"
        positive = run_cli(db, evidence, "run", "--scenario", "LEARNING_PLATFORM", "--operator", "synthetic-operator", "--budget-points", "1200")
        assert positive["reference_only"] is True and positive["release"] == "PRODUCTION_NO_GO"
        assert positive["result"]["outcome"] == "REFERENCE_FLOW_COMPLETE"
        assert len(positive["result"]["steps"]) == 9
        assert positive["result"]["real_product_integrations"] == 0
        assert positive["result"]["original_task_acceptance"] == 0
        negative = run_cli(db, evidence, "run", "--scenario", "LEARNING_PLATFORM", "--operator", "synthetic-operator", "--budget-points", "1200", "--inject-fault-at", "CONTRACT-05")
        assert negative["result"]["outcome"] == "BLOCKED_REFERENCE_CONTRACT"
        assert len(negative["result"]["steps"]) == 5
        assert negative["release"] == "PRODUCTION_NO_GO"
        doctor = run_cli(db, evidence, "doctor")
        assert doctor["health"] == "LOCAL_INTEGRITY_PASS"
        assert doctor["release"] == "PRODUCTION_NO_GO"
        assert doctor["no_real_adapters"] is True
    print(json.dumps({
        "result": "PASS", "simulation_only": True, "positive_steps": 9,
        "injected_fault_at": "CONTRACT-05", "failed_closed_at_step": 5,
        "doctor": "LOCAL_INTEGRITY_PASS", "live_integrations": 0,
        "accepted_original_tasks": 0, "release": "PRODUCTION_NO_GO"
    }, indent=2))


if __name__ == "__main__":
    main()
