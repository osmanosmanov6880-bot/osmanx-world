"""CI integration smoke: real M189 local gate -> M190 journal -> external anchor.

No network, production credentials, remote changes or real product integrations.
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from m190 import ledger


def main() -> int:
    with tempfile.TemporaryDirectory(prefix='osgard-m190-ci-') as folder:
        local = Path(folder)
        m189 = ROOT / 'm189'
        plan = ROOT / 'recovery' / 'ORIGINAL_180_TASKS.json'
        cmd = [sys.executable, str(m189 / 'admission.py'),
               '--plan', str(plan),
               '--master', str(ROOT / 'originals' / 'DIRECTOR_MASTER_180.md'),
               '--upstreams', str(m189 / 'data' / 'M189_UPSTREAMS.json'),
               '--submissions', str(m189 / 'data' / 'M189_SUBMISSIONS.json'),
               '--trust', str(m189 / 'data' / 'M189_TRUST_KEYS.json'),
               '--workspace', str(local / 'nonexistent-upstreams'),
               '--evidence-root', str(local / 'no-evidence'),
               '--output', str(local / 'm189.json')]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        if p.returncode:
            print(p.stderr, file=sys.stderr)
            return 1
        report = json.loads((local / 'm189.json').read_text())
        assert report['statuses'] == {'BLOCKED_UPSTREAM': 180}
        db = local / 'm190.sqlite'
        first = ledger.create(db, plan)
        assert first['head'] == ledger.GENESIS
        observed = ledger.ingest(db, plan_path=plan, report_path=local / 'm189.json',
                                 actor='ci-observer', expected_head=ledger.GENESIS)
        assert observed['events'] == 1 and observed['status_counts'] == {'BLOCKED_UPSTREAM': 180}
        assert observed['production_authorized'] is False
        annotated = ledger.add_note(db, task_id='TITAN-X01',
                                    message='Upstream still not owner-verified', actor='ci-reviewer',
                                    expected_head=observed['head'])
        assert annotated['events'] == 2
        anchor = local / 'separate-anchor.json'
        ledger.write_anchor(db, anchor, expected_head=annotated['head'])
        confirmed = ledger.verify_anchor(db, anchor)
        assert confirmed['status_counts'] == {'BLOCKED_UPSTREAM': 180}
        assert confirmed['original_task_acceptance'] == 0
        assert confirmed['release_gate'] == 'NO_GO'
        out = local / 'ledger-export.json'
        ledger.write_json_atomic(out, ledger.export_events(db, expected_head=annotated['head']))
        assert len(json.loads(out.read_text())['events']) == 2
        duplicate = ledger.ingest(db, plan_path=plan, report_path=local / 'm189.json',
                                  actor='ci-observer', expected_head=annotated['head'])
        assert duplicate['events'] == 2 and not duplicate['appended']
    print('M190_INTEGRATION_SMOKE_PASS: M189 -> 180 blocked -> 2 events -> anchor -> replay; NO_GO')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
