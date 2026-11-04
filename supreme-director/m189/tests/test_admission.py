"""M189 positive/negative acceptance regression tests; all keys/data synthetic."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from admission import admitted_baselines, canonical, evaluate, main, review_submission, safe_file, sha256

HERE = Path(__file__).resolve().parents[1]
PLAN = json.loads((HERE.parent / 'recovery' / 'ORIGINAL_180_TASKS.json').read_text(encoding='utf-8'))


def public_hex(key):
    return key.public_key().public_bytes(encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw).hex()


def sign(key, payload):
    return key.sign(canonical(payload)).hex()


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.workspace = self.root / 'sources'
        self.checkout = self.workspace / 'TITAN'
        self.checkout.mkdir(parents=True)
        self.logs = self.root / 'logs'
        self.logs.mkdir()
        self.owner = Ed25519PrivateKey.generate()
        self.reviewer = Ed25519PrivateKey.generate()
        self.trust = {'schema': 'osgard.m189.trust-keys/1',
                      'owner_keys': {'trusted-owner': public_hex(self.owner)},
                      'reviewer_keys': {'trusted-reviewer': public_hex(self.reviewer)}}
        self.registry = json.loads((HERE / 'data' / 'M189_UPSTREAMS.json').read_text(encoding='utf-8'))
        self.evidence = {'schema': 'osgard.m189.submissions/1', 'submissions': []}
        for name, body in [('code.txt', b'isolated-source\n'), ('ROLLBACK.md', b'rollback tested offline\n')]:
            (self.checkout / name).write_bytes(body)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Synthetic QA')
        self.git('config', 'user.email', 'qa@example.invalid')
        self.git('remote', 'add', 'origin', 'https://github.com/example/titan.git')
        self.git('add', '.')
        self.git('commit', '-qm', 'synthetic baseline')
        self.payload = {'team': 'TITAN', 'repo': 'https://github.com/example/titan.git',
                        'commit': self.git('rev-parse', 'HEAD'),
                        'tree': self.git('rev-parse', 'HEAD^{tree}')}
        self.registry['teams'][0] = {
            **self.payload,
            'owner_approval': {'key_id': 'trusted-owner', 'signature': sign(self.owner, self.payload)}
        }

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.checkout), *args], check=True,
                              capture_output=True, text=True, timeout=10).stdout.strip()

    def submission(self, task_id='TITAN-X01'):
        tests = []
        for kind in ('unit', 'integration', 'negative', 'regression', 'e2e'):
            path = kind + '.txt'
            content = (kind + ' PASSED in synthetic environment\n').encode()
            (self.logs / path).write_bytes(content)
            tests.append({'kind': kind, 'command': 'python -m unittest ' + kind,
                          'exit_code': 0, 'log_path': path,
                          'log_sha256': hashlib.sha256(content).hexdigest()})
        data = {
            'task_id': task_id, 'repo': self.payload['repo'], 'commit': self.payload['commit'],
            'author': 'synthetic-author',
            'artifacts': [{'path': 'code.txt', 'sha256': sha256(self.checkout / 'code.txt')}],
            'tests': tests, 'rollback_path': 'ROLLBACK.md',
            'rollback_sha256': sha256(self.checkout / 'ROLLBACK.md')
        }
        data['review'] = {'key_id': 'trusted-reviewer',
                          'signature': sign(self.reviewer, data)}
        return data

    def report(self):
        return evaluate(PLAN, self.registry, self.evidence, self.trust, self.workspace, self.logs)

    def status(self, task):
        return next(row['status'] for row in self.report()['tasks'] if row['id'] == task)

    def test_empty_registry_defaults_fail_closed(self):
        empty = json.loads((HERE / 'data' / 'M189_UPSTREAMS.json').read_text())
        report = evaluate(PLAN, empty, self.evidence, self.trust, self.workspace, self.logs)
        self.assertEqual(report['statuses'], {'BLOCKED_UPSTREAM': 180})
        self.assertFalse(report['production_authorized'])

    def test_locally_signed_upstream(self):
        status, accepted = admitted_baselines(self.registry, self.trust, self.workspace)
        self.assertEqual(status['TITAN']['status'], 'LOCAL_BASELINE_CHECKED')
        self.assertEqual(len(accepted), 1)
        self.assertEqual(status['ORBITAL']['status'], 'BLOCKED_UPSTREAM')

    def test_valid_signed_evidence_never_claims_product_acceptance(self):
        self.evidence['submissions'] = [self.submission()]
        report = self.report()
        self.assertEqual(self.status('TITAN-X01'), 'READY_FOR_EXTERNAL_REVIEW')
        self.assertEqual(report['signed_local_evidence_ready'], 1)
        self.assertEqual(report['original_task_acceptance'], 0)
        self.assertFalse(report['production_authorized'])

    def test_dependency_blocks_valid_signed_evidence(self):
        self.evidence['submissions'] = [self.submission('TITAN-X02')]
        self.assertEqual(self.status('TITAN-X02'), 'BLOCKED_DEPENDENCY')

    def test_missing_task_submission(self):
        self.assertEqual(self.status('TITAN-X01'), 'AWAITING_EVIDENCE')

    def test_forged_owner_signature(self):
        self.registry['teams'][0]['owner_approval']['signature'] = '0' * 128
        self.assertEqual(self.status('TITAN-X01'), 'BLOCKED_UPSTREAM')

    def test_unknown_key_is_not_trusted(self):
        self.registry['teams'][0]['owner_approval']['key_id'] = 'unknown'
        self.assertEqual(self.status('TITAN-X01'), 'BLOCKED_UPSTREAM')

    def test_head_mismatch_rejects_upstream(self):
        (self.checkout / 'additional.txt').write_text('drift')
        self.git('add', 'additional.txt')
        self.git('commit', '-qm', 'drift')
        self.assertEqual(self.status('TITAN-X01'), 'BLOCKED_UPSTREAM')

    def test_forged_reviewer_signature(self):
        entry = self.submission()
        entry['review']['signature'] = '0' * 128
        self.evidence['submissions'] = [entry]
        self.assertEqual(self.status('TITAN-X01'), 'EVIDENCE_REJECTED')

    def test_untrusted_author_change_invalidates_signature(self):
        entry = self.submission()
        entry['author'] = 'different-author'
        self.evidence['submissions'] = [entry]
        self.assertEqual(self.status('TITAN-X01'), 'EVIDENCE_REJECTED')

    def test_failed_test_rejected(self):
        entry = self.submission()
        entry['tests'][0]['exit_code'] = 1
        self.evidence['submissions'] = [entry]
        self.assertEqual(self.status('TITAN-X01'), 'EVIDENCE_REJECTED')

    def test_missing_test_category_rejected(self):
        entry = self.submission()
        entry['tests'] = entry['tests'][1:]
        self.evidence['submissions'] = [entry]
        self.assertEqual(self.status('TITAN-X01'), 'EVIDENCE_REJECTED')

    def test_tampered_log_sha_rejected(self):
        entry = self.submission()
        (self.logs / 'unit.txt').write_text('changed!')
        self.evidence['submissions'] = [entry]
        self.assertEqual(self.status('TITAN-X01'), 'EVIDENCE_REJECTED')

    def test_path_traversal_rejected(self):
        entry = self.submission()
        entry['artifacts'][0]['path'] = '../secret.txt'
        self.evidence['submissions'] = [entry]
        self.assertEqual(self.status('TITAN-X01'), 'EVIDENCE_REJECTED')

    def test_symlink_to_external_rejected(self):
        external = self.root / 'secret.txt'
        external.write_text('secret')
        link = self.checkout / 'sneaky.txt'
        link.symlink_to(external)
        with self.assertRaises(ValueError):
            safe_file(self.checkout, 'sneaky.txt')

    def test_duplicate_submission_rejected(self):
        self.evidence['submissions'] = [self.submission(), self.submission()]
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            self.report()

    def test_unknown_task_rejected(self):
        entry = self.submission('TITAN-X99')
        self.evidence['submissions'] = [entry]
        with self.assertRaisesRegex(ValueError, 'unknown'):
            self.report()

    def test_garbage_schema_rejected(self):
        self.registry['schema'] = 'osgard.m189.fake-schema/1'
        with self.assertRaisesRegex(ValueError, 'schema'):
            self.report()

    def test_false_verified_field_ignored_and_not_promoted(self):
        self.evidence['submissions'] = [self.submission()]
        report = self.report()
        self.assertEqual(report['original_task_acceptance'], 0)
        self.assertEqual(report['release_gate'], 'NO_GO')
        self.assertTrue(all(r['status'] != 'VERIFIED' for r in report['tasks']))


if __name__ == '__main__':
    unittest.main()
