"""M187 local source recovery tests. All acceptance remains external."""
from __future__ import annotations

import hashlib
from pathlib import Path
import tempfile
import unittest
import zipfile

from osgard_m187.plan import recover_master, sha256_file, validate_tasks, ORIGINAL_MASTER_SHA256
from osgard_m187.schedule import build_schedule
from osgard_m187.audit import inspect_archive, inspect_bundle, run_local_lab

ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT / 'originals/DIRECTOR_MASTER_180.md'


class HistoricalPlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plan = recover_master(MASTER)

    def test_master_sha_pinned(self):
        self.assertEqual(sha256_file(MASTER), ORIGINAL_MASTER_SHA256)

    def test_180_all_unique(self):
        tasks = self.plan['tasks']
        self.assertEqual(len(tasks), 180)
        self.assertEqual(len({t['id'] for t in tasks}), 180)
        self.assertTrue(all(t['original_status'] == 'PLANNED' for t in tasks))

    def test_six_teams(self):
        self.assertEqual(set(self.plan['counts']['teams']),
                         {'TITAN', 'NEXUS', 'COMMERCE', 'EXPERIENCE', 'GENESIS', 'ORBITAL'})
        self.assertTrue(all(v == 30 for v in self.plan['counts']['teams'].values()))

    def test_priorities(self):
        self.assertEqual(self.plan['counts']['priorities'], {'P0': 60, 'P1': 90, 'P2': 30})

    def test_294_refs(self):
        self.assertEqual(self.plan['counts']['explicit_references_in_this_document'], 294)

    def test_no_false_acceptance(self):
        for task in self.plan['tasks']:
            self.assertFalse(task['independent_acceptance'])
            self.assertFalse(task['current_verified_integration'])
            self.assertEqual(task['m181_task_board_correspondence'], 'NOT_ESTABLISHED')

    def test_actual_source_lines_valid(self):
        lines = MASTER.read_text().splitlines()
        for task in self.plan['tasks']:
            self.assertIn(task['id'], lines[task['source_line'] - 1])

    def test_detect_modified_master(self):
        with tempfile.TemporaryDirectory() as dirname:
            dst = Path(dirname) / 'modified.md'
            dst.write_bytes(MASTER.read_bytes() + b'\nALTERED\n')
            with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
                recover_master(dst)

    def test_unknown_parent_rejected(self):
        modified = [dict(t) for t in self.plan['tasks']]
        modified[0]['explicit_deps'] = ['TITAN-X99']
        with self.assertRaisesRegex(ValueError, 'Unresolved reference'):
            validate_tasks(modified)

    def test_cycle_rejected(self):
        modified = [dict(t) for t in self.plan['tasks']]
        modified[0]['explicit_deps'] = ['TITAN-X02']
        with self.assertRaisesRegex(ValueError, 'Circular explicit dependency'):
            validate_tasks(modified)

    def test_schedule_4_waves(self):
        schedule = build_schedule(self.plan['tasks'])
        self.assertEqual(schedule['task_count'], 180)
        self.assertEqual(schedule['explicit_dependency_edges'], 294)
        self.assertEqual(schedule['topological_wave_count'], 4)
        self.assertEqual(len(schedule['root_dependencies']), 6)
        self.assertEqual(sum(w['task_count'] for w in schedule['waves']), 180)
        self.assertEqual(len(schedule['all_task_execution_states']), 180)
        self.assertEqual(schedule['original_independent_acceptance'], 0)

    def test_dependency_order(self):
        schedule = build_schedule(self.plan['tasks'])
        order = {task_id: n for n, w in enumerate(schedule['waves']) for task_id in w['task_ids']}
        for task in self.plan['tasks']:
            for parent in task['explicit_deps']:
                self.assertLess(order[parent], order[task['id']])


class ArchiveSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'candidate.zip'

    def make(self, entries):
        with zipfile.ZipFile(self.path, 'w') as z:
            for name, value in entries:
                z.writestr(name, value)
        return sha256_file(self.path)

    def test_missing_archives(self):
        self.assertEqual(inspect_archive(None)['status'], 'MISSING')

    def test_unpinned_not_canonical(self):
        self.make([('Main.gd', b'example')])
        checked = inspect_archive(self.path)
        self.assertEqual(checked['status'], 'CRC_PASS_UNPINNED')
        self.assertFalse(checked['proves_canonical_M180_M181'])

    def test_pinned_archive_crc(self):
        sha = self.make([('Main.gd', b'example')])
        self.assertEqual(inspect_archive(self.path, sha)['status'], 'SHA_PIN_AND_CRC_PASS')

    def test_wrong_sha_blocks_first(self):
        self.make([('Main.gd', b'example')])
        self.assertEqual(inspect_archive(self.path, 'a' * 64)['status'], 'SHA256_MISMATCH')

    def test_traversal(self):
        self.make([('../unsafe.txt', b'a')])
        self.assertEqual(inspect_archive(self.path)['status'], 'UNSAFE_PATH')

    def test_absolute_path(self):
        self.make([('/etc/password', b'a')])
        self.assertEqual(inspect_archive(self.path)['status'], 'UNSAFE_PATH')

    def test_duplicates(self):
        self.make([('foo.txt', b'a'), ('FOO.TXT', b'b')])
        self.assertEqual(inspect_archive(self.path)['status'], 'DUPLICATE_ENTRY')

    def test_entry_count(self):
        self.make([('a.txt', b'a'), ('b.txt', b'b')])
        self.assertEqual(inspect_archive(self.path, max_members=1)['status'], 'ENTRY_COUNT_LIMIT')

    def test_zip_not_an_archive(self):
        self.path.write_bytes(b'nope')
        self.assertEqual(inspect_archive(self.path)['status'], 'BAD_ARCHIVE')


class ExecutableLocalChecksTests(unittest.TestCase):
    def test_reference_lab_and_fail_closed(self):
        result = run_local_lab(ROOT)
        self.assertEqual(result['status'], 'PASS_LOCAL_REFERENCE_ONLY')
        self.assertEqual(result['healthy_steps'], 9)
        self.assertEqual(result['blocked_steps'], 5)
        self.assertEqual(result['doctor'], 'LOCAL_INTEGRITY_PASS')
        self.assertEqual(result['original_task_acceptance'], 0)

    def test_bundle_still_missing_original_m180_m181(self):
        actual = inspect_bundle(ROOT / 'evidence/m186/M186_LOCAL_HISTORY.bundle')
        self.assertEqual(actual['status'], 'LOCAL_GIT_BUNDLE_INSPECTED')
        self.assertTrue(actual['m186_commit_found'])
        self.assertFalse(actual['m180_commit_found'])
        self.assertFalse(actual['m181_commit_found'])


if __name__ == '__main__':
    unittest.main()
