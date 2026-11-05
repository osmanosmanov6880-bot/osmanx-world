"""Original 180 coverage, provenance, and audit fail-closed tests."""
from collections import Counter
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from campaign180.registry import EvidenceError, MASTER_SHA256, load_original, load_upstreams
from campaign180.audit import audit_original, save_reports, HOLD_SCOPE, HOLD_MISSING

REPO=Path(__file__).resolve().parents[3]


class CampaignTests(unittest.TestCase):
    def test_original_is_exact_180_with_six_teams(self):
        original=load_original(REPO)
        tasks=original['tasks']
        self.assertEqual(len(tasks),180)
        self.assertEqual(len({t['id'] for t in tasks}),180)
        self.assertEqual(Counter(t['priority'] for t in tasks),{'P0':60,'P1':90,'P2':30})
        self.assertEqual(Counter(t['team'] for t in tasks),dict.fromkeys(
            ('TITAN','NEXUS','COMMERCE','EXPERIENCE','GENESIS','ORBITAL'),30))
        self.assertEqual(original['original_master_sha256'],MASTER_SHA256)

    def test_six_upstreams_are_not_improperly_assigned(self):
        original=load_upstreams(REPO)
        self.assertEqual(len(original['teams']),6)
        self.assertFalse(any(t['owner_approved'] for t in original['teams'].values()))
        self.assertTrue(all(t['repository_url'] is None for t in original['teams'].values()))

    def test_audit_covers_all_180_without_fake_acceptances(self):
        report=audit_original(REPO)
        self.assertEqual(report['counts']['total'],180)
        self.assertEqual(report['counts']['independently_accepted'],0)
        self.assertEqual(report['counts']['production_accepted'],0)
        self.assertEqual(len(report['task_ledger']),180)
        self.assertTrue(all(not x['independently_accepted'] for x in report['task_ledger']))
        self.assertEqual(report['counts']['hold_scope_excluded'],4)
        self.assertEqual(report['counts']['hold_source_missing'],4)
        self.assertEqual(len(HOLD_SCOPE),4)
        self.assertEqual(len(HOLD_MISSING),4)

    def test_local_work_is_not_original_product_completion(self):
        report=audit_original(REPO)
        mapped={x['id']:x for x in report['task_ledger']}
        for name in ('TITAN-X01','TITAN-X02','TITAN-X03','TITAN-X06'):
            self.assertTrue(mapped[name]['related_local_paths'])
            self.assertEqual(mapped[name]['implementation_evidence_status'],
                             'RELATED_LOCAL_CODE_NOT_ACCEPTED')
            self.assertFalse(mapped[name]['independently_accepted'])
        for name in HOLD_SCOPE:
            self.assertEqual(mapped[name]['implementation_evidence_status'],
                             'HOLD_SCOPE_EXCLUDED')
        for name in HOLD_MISSING:
            self.assertEqual(mapped[name]['implementation_evidence_status'],
                             'HOLD_SOURCE_MISSING')

    def test_markdown_and_json_have_same_exact_task_ids(self):
        with tempfile.TemporaryDirectory() as temp:
            payload=save_reports(REPO,Path(temp))
            data=json.loads((Path(temp)/'audit_180.json').read_text())
            md=(Path(temp)/'audit_180.md').read_text()
            self.assertEqual(data['counts'],payload['counts'])
            self.assertEqual(md.count('| TITAN-X'),30)
            self.assertEqual(md.count('| NEXUS-X'),30)
            self.assertEqual(md.count('| COMMERCE-X'),30)
            self.assertEqual(md.count('| EXPERIENCE-X'),30)
            self.assertEqual(md.count('| GENESIS-X'),30)
            self.assertEqual(md.count('| ORBITAL-X'),30)

    def test_modified_evidence_path_fails_closed(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t)
            for relative in (
                'supreme-director/originals/DIRECTOR_MASTER_180.md',
                'supreme-director/recovery/ORIGINAL_180_TASKS.json',
                'supreme-director/campaign180/data/EVIDENCE_MAP.json',
                'supreme-director/campaign180/data/UPSTREAM_REGISTRY.json',
            ):
                (root/relative).parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(REPO/relative,root/relative)
            record=root/'supreme-director/campaign180/data/EVIDENCE_MAP.json'
            data=json.loads(record.read_text())
            data['related_local_paths']['TITAN-X01']=['does-not-exist.bin']
            record.write_text(json.dumps(data))
            with self.assertRaises(EvidenceError):
                audit_original(root)

    def test_changed_master_sha_fails_closed(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t)
            src='supreme-director/originals/DIRECTOR_MASTER_180.md'
            dst=root/src
            dst.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(REPO/src,dst)
            dst.write_bytes(dst.read_bytes()+b'\nmodified\n')
            with self.assertRaises(EvidenceError):
                load_original(root)

    def test_upstream_approval_requires_distinct_real_reviewers(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t)
            p=root/'supreme-director/campaign180/data/UPSTREAM_REGISTRY.json'
            p.parent.mkdir(parents=True,exist_ok=True)
            data=load_upstreams(REPO)
            data['teams']['TITAN'].update({'owner_approved':True,
                'repository_url':'https://github.com/fake/repo',
                'commit_sha':'a'*40,'approved_by':'same','independent_reviewer':'same'})
            p.write_text(json.dumps(data))
            with self.assertRaises(EvidenceError):
                load_upstreams(root)


if __name__=='__main__':unittest.main()
