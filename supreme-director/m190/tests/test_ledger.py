"""M190 adversarial/offline tests; absolutely no production or network requests."""
from __future__ import annotations

import copy
from contextlib import closing
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from m190 import ledger

PLAN = Path(__file__).resolve().parents[2] / 'recovery' / 'ORIGINAL_180_TASKS.json'


def sample_report(plan_path: Path = PLAN) -> dict:
    tasks = json.loads(plan_path.read_text(encoding='utf-8'))['tasks']
    return {
        'schema': 'osgard.m189.admission-report/1',
        'original_task_acceptance': 0,
        'verified_production_upstreams': 0,
        'production_authorized': False,
        'release_gate': 'NO_GO',
        'signed_local_evidence_ready': 0,
        'statuses': {'BLOCKED_UPSTREAM': 180},
        'tasks': [{'id': t['id'], 'team': t['team'], 'priority': t['priority'],
                   'depends_on': t['explicit_deps'], 'status': 'BLOCKED_UPSTREAM',
                   'reason': 'MISSING_CANONICAL_SOURCE'} for t in tasks],
    }


class M190Tests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.db = self.folder / 'journal.db'
        self.report_file = self.folder / 'm189.json'
        self.plan = PLAN
        self.report = sample_report()
        self.save()
        self.genesis = ledger.create(self.db, self.plan)

    def save(self):
        self.report_file.write_text(json.dumps(self.report, sort_keys=True), encoding='utf-8')

    def observe(self, **kw):
        self.save()
        return ledger.ingest(self.db, plan_path=kw.get('plan', self.plan),
                             report_path=self.report_file, actor=kw.get('actor', 'local-operator'),
                             expected_head=kw.get('head', ledger.verify(self.db)['head']))

    def test_genesis(self):
        self.assertEqual(self.genesis['head'], ledger.GENESIS)
        self.assertEqual(self.genesis['events'], 0)
        self.assertFalse(self.genesis['production_authorized'])
        self.assertFalse(self.genesis['external_anchor_checked'])

    def test_refuse_overwrite(self):
        with self.assertRaisesRegex(ledger.LedgerError, 'already exists'):
            ledger.create(self.db, self.plan)

    def test_observe_180_blocked(self):
        result = self.observe()
        self.assertEqual(result['events'], 1)
        self.assertEqual(result['status_counts'], {'BLOCKED_UPSTREAM': 180})
        self.assertEqual(result['unique_reports'], 1)
        self.assertEqual(result['original_task_acceptance'], 0)
        self.assertEqual(result['release_gate'], 'NO_GO')

    def test_immutable_note_does_not_accept(self):
        prev = self.observe()
        next_ = ledger.add_note(self.db, task_id='TITAN-X01', actor='reviewer-1',
                                message='Need immutable upstream SHA',
                                expected_head=prev['head'])
        self.assertEqual(next_['status_counts'], {'BLOCKED_UPSTREAM': 180})
        self.assertEqual(next_['notes'], 1)
        self.assertEqual(next_['original_task_acceptance'], 0)

    def test_reopen_replay(self):
        self.observe()
        state = ledger.verify(self.db)
        self.assertNotEqual(state['head'], ledger.GENESIS)
        self.assertEqual(ledger.verify(self.db, expected_head=state['head'])['events'], 1)

    def test_duplicate_identical_report_noop(self):
        first = self.observe()
        second = self.observe(head=first['head'])
        self.assertFalse(second['appended'])
        self.assertEqual(second['events'], 1)
        self.assertEqual(second['head'], first['head'])

    def test_new_report_new_digest(self):
        first = self.observe()
        self.report['tasks'][0]['reason'] = 'SYNTHETIC_BLOCKER'
        second = self.observe(head=first['head'])
        self.assertEqual(second['events'], 2)
        self.assertEqual(second['unique_reports'], 2)

    def test_stale_head_refused(self):
        self.observe()
        with self.assertRaisesRegex(ledger.LedgerError, 'STALE_HEAD'):
            ledger.add_note(self.db, task_id='TITAN-X01', actor='operator',
                            message='stale update', expected_head=ledger.GENESIS)
        self.assertEqual(ledger.verify(self.db)['events'], 1)

    def test_invalid_actor_refused(self):
        with self.assertRaises(ledger.LedgerError):
            ledger.add_note(self.db, task_id='TITAN-X01', actor='someone;rm -rf /',
                            message='bad', expected_head=ledger.GENESIS)

    def test_note_task_refused(self):
        with self.assertRaisesRegex(ledger.LedgerError, 'unknown task'):
            ledger.add_note(self.db, task_id='TITAN-X99', actor='operator',
                            message='bad', expected_head=ledger.GENESIS)

    def test_note_controls_refused(self):
        with self.assertRaisesRegex(ledger.LedgerError, 'control characters'):
            ledger.add_note(self.db, task_id='TITAN-X01', actor='operator',
                            message='test\x00secret', expected_head=ledger.GENESIS)

    def test_note_too_long(self):
        with self.assertRaises(ledger.LedgerError):
            ledger.add_note(self.db, task_id='TITAN-X01', actor='operator',
                            message='a' * 1201, expected_head=ledger.GENESIS)

    def test_invalid_note_reference(self):
        with self.assertRaises(ledger.LedgerError):
            ledger.add_note(self.db, task_id='TITAN-X01', actor='operator',
                            message='proof', reference_sha256='not-a-sha',
                            expected_head=ledger.GENESIS)

    def test_valid_note_reference_and_export(self):
        self.observe()
        ledger.add_note(self.db, task_id='TITAN-X01', actor='operator',
                        message='artifact digest', reference_sha256='a' * 64,
                        expected_head=ledger.verify(self.db)['head'])
        doc = ledger.export_events(self.db)
        self.assertEqual(len(doc['events']), 2)
        self.assertEqual(doc['events'][1]['payload']['reference_sha256'], 'a' * 64)
        self.assertTrue(doc['no_external_actions'])
        self.assertFalse(doc['summary']['production_authorized'])

    def test_report_schema_refused(self):
        self.report['schema'] = 'forged-report'
        with self.assertRaisesRegex(ledger.LedgerError, 'M189 admission'):
            self.observe()

    def test_unknown_status_refused(self):
        self.report['tasks'][0]['status'] = 'VERIFIED'
        with self.assertRaisesRegex(ledger.LedgerError, 'fabricated VERIFIED'):
            self.observe()

    def test_production_claim_refused(self):
        self.report['production_authorized'] = True
        with self.assertRaisesRegex(ledger.LedgerError, 'production'):
            self.observe()

    def test_fake_original_acceptance_refused(self):
        self.report['original_task_acceptance'] = 1
        with self.assertRaises(ledger.LedgerError):
            self.observe()

    def test_tampered_status_counter(self):
        self.report['statuses'] = {'READY_FOR_EXTERNAL_REVIEW': 180}
        with self.assertRaisesRegex(ledger.LedgerError, 'tally'):
            self.observe()

    def test_duplicate_task_row_refused(self):
        self.report['tasks'][1] = copy.deepcopy(self.report['tasks'][0])
        with self.assertRaisesRegex(ledger.LedgerError, 'duplicate task'):
            self.observe()

    def test_wrong_priority_refused(self):
        self.report['tasks'][0]['priority'] = 'P2'
        with self.assertRaisesRegex(ledger.LedgerError, 'metadata'):
            self.observe()

    def test_wrong_dependency_refused(self):
        self.report['tasks'][0]['depends_on'] = ['NEXUS-X01']
        with self.assertRaisesRegex(ledger.LedgerError, 'metadata'):
            self.observe()

    def test_plan_byte_drift_refused(self):
        alt = self.folder / 'altered_plan.json'
        alt.write_bytes(self.plan.read_bytes() + b'\n')
        with self.assertRaisesRegex(ledger.LedgerError, 'plan bytes drifted'):
            self.observe(plan=alt)

    def test_immutable_update_and_delete_triggers(self):
        self.observe()
        with closing(sqlite3.connect(self.db)) as c, c:
            with self.assertRaises(sqlite3.IntegrityError):
                c.execute("UPDATE events SET actor='attacker' WHERE seq=1")
            with self.assertRaises(sqlite3.IntegrityError):
                c.execute('DELETE FROM events WHERE seq=1')
        self.assertEqual(ledger.verify(self.db)['events'], 1)

    def test_triggers_deleted_detected(self):
        self.observe()
        with closing(sqlite3.connect(self.db)) as c, c:
            c.execute('DROP TRIGGER immutable_events_delete')
        with self.assertRaisesRegex(ledger.LedgerError, 'triggers missing'):
            ledger.verify(self.db)

    def test_tampered_payload_detected(self):
        self.observe()
        with closing(sqlite3.connect(self.db)) as c, c:
            c.execute('DROP TRIGGER immutable_events_update')
            c.execute("UPDATE events SET payload_json='{}' WHERE seq=1")
        with self.assertRaises(ledger.LedgerError):
            ledger.verify(self.db)

    def test_external_anchor_seal_and_check(self):
        self.observe()
        anchor = self.folder / 'external' / 'anchor.json'
        doc = ledger.write_anchor(self.db, anchor, expected_head=ledger.verify(self.db)['head'])
        self.assertEqual(ledger.verify_anchor(self.db, anchor)['head'], doc['head'])
        self.assertTrue(ledger.verify_anchor(self.db, anchor)['external_anchor_checked'])

    def test_external_anchor_detects_truncation(self):
        first = self.observe()
        ledger.add_note(self.db, task_id='TITAN-X02', actor='operator',
                        message='for later', expected_head=first['head'])
        anchor = self.folder / 'anchor.json'
        ledger.write_anchor(self.db, anchor)
        with closing(sqlite3.connect(self.db)) as c, c:
            c.execute('DROP TRIGGER immutable_events_delete')
            c.execute('DELETE FROM events WHERE seq=2')
            # Privileged attacker can recreate trigger to forge an apparently valid shorter chain.
            c.execute("CREATE TRIGGER immutable_events_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'event history is immutable'); END")
        self.assertEqual(ledger.verify(self.db)['events'], 1)
        with self.assertRaisesRegex(ledger.LedgerError, 'EXTERNAL_HEAD_MISMATCH'):
            ledger.verify_anchor(self.db, anchor)

    def test_anchor_wrong_plan_refused(self):
        self.observe()
        anchor = self.folder / 'anchor.json'
        ledger.write_anchor(self.db, anchor)
        data = json.loads(anchor.read_text())
        data['plan_sha256'] = 'b' * 64
        anchor.write_text(json.dumps(data))
        with self.assertRaisesRegex(ledger.LedgerError, 'anchor metadata'):
            ledger.verify_anchor(self.db, anchor)

    def test_self_embedded_anchor_not_external_proof(self):
        result = self.observe()
        self.assertIn('independently stored head', result['warning'])
        self.assertFalse(ledger.verify(self.db)['external_anchor_checked'])

    def test_valid_ready_for_review_never_promotes(self):
        self.report['tasks'][0]['status'] = 'READY_FOR_EXTERNAL_REVIEW'
        self.report['statuses'] = {'BLOCKED_UPSTREAM': 179, 'READY_FOR_EXTERNAL_REVIEW': 1}
        self.report['signed_local_evidence_ready'] = 1
        result = self.observe()
        self.assertEqual(result['status_counts']['READY_FOR_EXTERNAL_REVIEW'], 1)
        self.assertEqual(result['original_task_acceptance'], 0)
        self.assertFalse(result['production_authorized'])

    def test_cli_fail_closed_bad_expected_head(self):
        cli = [sys.executable, '-m', 'm190', 'note', '--db', str(self.db),
               '--actor', 'operator', '--task', 'TITAN-X01', '--message', 'testing',
               '--expected-head', 'f' * 64]
        proc = subprocess.run(cli, cwd=Path(__file__).resolve().parents[2],
                              capture_output=True, text=True, timeout=8)
        self.assertEqual(proc.returncode, 2)
        self.assertIn('STALE_HEAD', proc.stderr)

    def test_cli_verify_and_export(self):
        result = self.observe()
        export = self.folder / 'ledger.json'
        proc = subprocess.run([sys.executable, '-m', 'm190', 'export', '--db', str(self.db),
                               '--expected-head', result['head'], '--output', str(export)],
                              cwd=Path(__file__).resolve().parents[2],
                              capture_output=True, text=True, timeout=8)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(export.read_text())['summary']['events'], 1)


if __name__ == '__main__':
    unittest.main()
