#!/usr/bin/env python3
"""Read-only integrity gate for the historical SUPREME DIRECTOR 180 campaign."""
import collections
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "originals" / "DIRECTOR_MASTER_180.md"
PLAN = ROOT / "recovery" / "ORIGINAL_180_TASKS.json"
REPORT = ROOT / "recovery" / "M187_RECOVERY_REPORT.json"
EXPECTED_SOURCE_SHA = "71fdda8231e1cb627a36fa683eaab1c28e4bdff2da9c95e0e6f6df83624a4b6c"
TEAMS = ("TITAN", "NEXUS", "COMMERCE", "EXPERIENCE", "GENESIS", "ORBITAL")

def validate():
    source_sha = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    if source_sha != EXPECTED_SOURCE_SHA:
        raise ValueError("Original master-plan SHA-256 mismatch")
    plan = json.loads(PLAN.read_text(encoding="utf-8"))
    report = json.loads(REPORT.read_text(encoding="utf-8"))
    tasks = plan.get("tasks", [])
    if len(tasks) != 180:
        raise ValueError("The plan must contain exactly 180 tasks")
    ids = {t["id"] for t in tasks}
    if len(ids) != len(tasks):
        raise ValueError("Duplicate task IDs")
    teams = collections.Counter(t["team"] for t in tasks)
    if teams != {x: 30 for x in TEAMS}:
        raise ValueError("Unexpected team distribution: " + repr(teams))
    priorities = collections.Counter(t["priority"] for t in tasks)
    if priorities != {"P0": 60, "P1": 90, "P2": 30}:
        raise ValueError("Unexpected priority distribution: " + repr(priorities))
    if any(t.get("current_verified_integration") or t.get("independent_acceptance") for t in tasks):
        raise ValueError("Unsourced acceptance status detected")
    if plan.get("original_task_acceptance") not in (0, None):
        raise ValueError("Original acceptance unexpectedly changed")
    if report.get("accepted_original_tasks") != 0:
        raise ValueError("Recovery evidence unexpectedly claims completed tasks")
    deps = {t["id"]: t.get("explicit_deps", []) for t in tasks}
    if any(not isinstance(d, list) for d in deps.values()):
        raise ValueError("Invalid dependency list")
    references = sum(len(d) for d in deps.values())
    if references != 294:
        raise ValueError("Expected 294 historical dependency references")
    for task, links in deps.items():
        for dependency in links:
            if dependency not in ids:
                raise ValueError("Unknown dependency: " + task + " -> " + dependency)
            if dependency == task:
                raise ValueError("Self-dependency: " + task)
    visited, visiting = set(), set()
    def visit(task):
        if task in visiting:
            raise ValueError("Dependency cycle at " + task)
        if task in visited:
            return
        visiting.add(task)
        for child in deps[task]:
            visit(child)
        visiting.remove(task)
        visited.add(task)
    for task in ids:
        visit(task)
    return {
        "schema": "osgard.m187.plan-integrity/1",
        "result": "PASS", "plan_sha256": source_sha,
        "tasks": len(tasks), "dependency_references": references,
        "teams": dict(sorted(teams.items())),
        "priorities": dict(sorted(priorities.items())),
        "original_tasks_accepted": 0, "production_release_authorized": False
    }

if __name__ == "__main__":
    try:
        print(json.dumps(validate(), ensure_ascii=False, indent=2))
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as e:
        print("PLAN_INTEGRITY_FAIL: " + str(e), file=sys.stderr)
        sys.exit(1)
