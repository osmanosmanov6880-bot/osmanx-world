"""CODEOWNERS, source mutation gate and dependency inventory tests."""
from pathlib import Path
import json
import shutil
import subprocess
import tempfile
import unittest

from campaign180.registry import EvidenceError, repository_inventory
from campaign180.gates import validate_codeowners,check_change_set,owner_for,dependency_risks

REPO=Path(__file__).resolve().parents[3]


def fixture_repo(path):
    subprocess.run(['git','init','-q',str(path)],check=True)
    (path/'.github').mkdir()
    shutil.copyfile(REPO/'.github/CODEOWNERS',path/'.github/CODEOWNERS')
    (path/'supreme-director/campaign180/data').mkdir(parents=True)
    shutil.copyfile(REPO/'supreme-director/campaign180/data/UPSTREAM_REGISTRY.json',
                    path/'supreme-director/campaign180/data/UPSTREAM_REGISTRY.json')
    (path/'README.md').write_text('test repository\n')
    subprocess.run(['git','-C',str(path),'add','.'],check=True)
    subprocess.run(['git','-C',str(path),'-c','user.name=Test',
                    '-c','user.email=test@example.com','commit','-qm','init'],check=True)


class GateTests(unittest.TestCase):
    def test_repo_declares_explicit_codeowners_rules(self):
        out=validate_codeowners(REPO)
        self.assertTrue(out['validated'])
        self.assertFalse(out['independent_reviewer_established'])

    def test_owner_classification_for_six_product_sources(self):
        self.assertEqual(owner_for('sources/TITAN/app/engine.py'),'TITAN')
        self.assertEqual(owner_for('supreme-director/local-kit/sources/NEXUS/app.py'),'NEXUS')
        self.assertIsNone(owner_for('supreme-director/m206/README.md'))

    def test_change_gate_allows_local_campaign_development(self):
        checked=check_change_set(REPO,[
            'supreme-director/campaign180/campaign180/audit.py',
            '.github/CODEOWNERS',
            '.github/workflows/supreme-director-campaign180.yml'
        ])
        self.assertTrue(checked['admitted_for_local_nonproduction_development'])
        self.assertFalse(checked['production_deploy_authorized'])

    def test_change_gate_blocks_original_master_tampering(self):
        result=check_change_set(REPO,['supreme-director/originals/DIRECTOR_MASTER_180.md'])
        self.assertIn('ORIGINAL_SOURCE_MODIFICATION_REQUIRES_OWNER_REVIEW',result['issues'])

    def test_change_gate_blocks_cross_team_writes(self):
        result=check_change_set(REPO,['sources/NEXUS/app.py','sources/TITAN/worker.py'])
        self.assertIn('CROSS_TEAM_WRITE_WITHOUT_INDEPENDENT_REVIEW',result['issues'])
        self.assertIn('UNVERIFIED_UPSTREAM_PRODUCT_SOURCE_WRITE',result['issues'])

    def test_change_gate_blocks_sensitive_file_names(self):
        for name in ['.env','config/key.pem','infra/id_rsa']:
            with self.subTest(name=name):
                out=check_change_set(REPO,[name])
                self.assertIn('SENSITIVE_PATH_CHANGE',out['issues'])

    def test_path_traversal_is_rejected(self):
        with self.assertRaises(EvidenceError):
            check_change_set(REPO,['../other-repo/secrets'])

    def test_local_git_inventory_contains_immutable_sha_and_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            fixture_repo(Path(d))
            info=repository_inventory(Path(d))
            self.assertEqual(len(info['repository_commit']),40)
            self.assertGreaterEqual(info['file_count'],3)
            self.assertEqual(len(info['file_manifest_sha256']),64)
            self.assertEqual(info['upstream_approved_count'],0)
            self.assertFalse(info['external_deploy_authorized'])

    def test_dependency_scan_does_not_install_packages(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d);fixture_repo(path)
            (path/'requirements-dev.txt').write_text('pytest>=8\nhelper==1.2.3\n')
            subprocess.run(['git','-C',d,'add','.'],check=True)
            subprocess.run(['git','-C',d,'-c','user.name=Test',
                            '-c','user.email=test@example.com','commit','-qm','deps'],check=True)
            out=dependency_risks(path)
            self.assertFalse(out['network_installs'])
            self.assertIn('UNPINNED_REQUIREMENT',{r['rule'] for r in out['risks']})

    def test_codeowners_missing_guard_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'.github/CODEOWNERS';p.parent.mkdir()
            p.write_text('* @osmanosmanov6880-bot\n')
            with self.assertRaises(EvidenceError):validate_codeowners(Path(d))


if __name__=='__main__':unittest.main()
