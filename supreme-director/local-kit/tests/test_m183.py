"""M183 unit tests verify LOCAL tooling only, not OSGARD six products."""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock

from osgard_m183 import core, dashboard, criteria
from osgard_m183.cli import main

ROOT = Path(__file__).resolve().parent.parent
ORIGINAL_PLAN = json.loads((ROOT / 'docs/M182_WORKPLAN_180_PROPOSED.json').read_text(encoding='utf-8'))
OLD = json.loads((ROOT / 'docs/SOURCE_PROVENANCE_RECONCILIATION.json').read_text(encoding='utf-8'))
CURRENT = json.loads((ROOT / 'docs/m183/CURRENT_GITHUB_DEFAULT_BRANCH_OBSERVATIONS_2026-10-27.json').read_text(encoding='utf-8'))
ARCHIVE = ROOT / 'inputs/OSGARD_M182_PARENT_UNMODIFIED.zip'


class Setup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def put(self, name, obj):
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(obj, ensure_ascii=False), encoding='utf-8')
        return p

    def plan(self, edit=None):
        p = copy.deepcopy(ORIGINAL_PLAN)
        if edit:
            edit(p)
        return core.validate_workplan(self.put('board.json', p))

    def snapshots(self, change=None):
        first = copy.deepcopy(OLD)
        second = copy.deepcopy(CURRENT)
        if change:
            change(first, second)
        return core.compare_git_observations(self.put('old.json', first), self.put('cur.json', second))


class WorkPlanTests(Setup):
    def test_original_proposed_board_structure(self):
        self.assertEqual(self.plan()['status'], 'VALID_LOCAL_PROPOSAL_ONLY')

    def test_exact_new_plan_counts(self):
        counts = self.plan()['counts']
        self.assertEqual(counts['tasks'], 180)
        self.assertEqual(counts['new_plan_edges'], 174)
        self.assertEqual(counts['tasks_by_phase'], core.PHASE_QUOTAS)

    def test_six_discovery_only(self):
        x = self.plan()['discovery_ready_ids']
        self.assertEqual(len(x), 6)
        self.assertTrue(all(y.endswith('A01') for y in x))

    def test_reject_179(self):
        self.assertEqual(self.plan(lambda b: b['tasks'].pop())['status'], 'BLOCKED')

    def test_reject_duplicate(self):
        self.assertEqual(self.plan(lambda b: b['tasks'][1].update(id=b['tasks'][0]['id']))['status'], 'BLOCKED')

    def test_reject_wrong_team(self):
        self.assertEqual(self.plan(lambda b: b['tasks'][0].update(team='ORBITAL'))['status'], 'BLOCKED')

    def test_reject_wrong_phase(self):
        self.assertEqual(self.plan(lambda b: b['tasks'][0].update(phase='D'))['status'], 'BLOCKED')

    def test_reject_forged_accepted(self):
        r=self.plan(lambda b: b['tasks'][0].update(status='ACCEPTED'))
        self.assertIn('WORKPLAN_FALSE_ACCEPTANCE', [x['code'] for x in r['findings']])

    def test_reject_forged_original_id(self):
        r=self.plan(lambda b: b['tasks'][0].update(source_task_id='TITAN-X01'))
        self.assertEqual(r['status'], 'BLOCKED')

    def test_reject_plan_claims_original(self):
        r=self.plan(lambda b: b.update(not_original_M181_board=False))
        self.assertIn('WORKPLAN_ORIGIN', [x['code'] for x in r['findings']])

    def test_reject_missing_parent(self):
        r=self.plan(lambda b: b['tasks'][1].update(local_dependencies=['NOT-A-TASK']))
        self.assertIn('WORKPLAN_UNKNOWN_PARENT', [x['code'] for x in r['findings']])

    def test_reject_bad_deps(self):
        self.assertEqual(self.plan(lambda b: b['tasks'][0].update(local_dependencies='missing'))['status'], 'BLOCKED')

    def test_reject_cycle(self):
        r=self.plan(lambda b: b['tasks'][0].update(local_dependencies=[b['tasks'][1]['id']]))
        self.assertIn('WORKPLAN_CYCLE', [x['code'] for x in r['findings']])

    def test_reject_changed_edge_count(self):
        r=self.plan(lambda b: b['tasks'][1].update(local_dependencies=[]))
        self.assertIn('WORKPLAN_EDGES', [x['code'] for x in r['findings']])

    def test_reject_extra_zero_frontier(self):
        def edit(b):
            t=b['tasks'][1]
            t['local_dependencies']=[]
            b['tasks'][2]['local_dependencies'].append(b['tasks'][0]['id'])
        r=self.plan(edit)
        self.assertIn('WORKPLAN_FRONTIER', [x['code'] for x in r['findings']])

    def test_reject_backwards_phase(self):
        def edit(b):
            a=next(t for t in b['tasks'] if t['phase']=='A')
            d=next(t for t in b['tasks'] if t['phase']=='D')
            a['local_dependencies'].append(d['id'])
        r=self.plan(edit)
        self.assertIn('WORKPLAN_PHASE_REVERSE', [x['code'] for x in r['findings']])

    def test_reject_invalid_schema(self):
        self.assertEqual(self.plan(lambda b: b.update(schema='fake'))['status'], 'BLOCKED')

    def test_reject_nonobject_task(self):
        self.assertEqual(self.plan(lambda b: b['tasks'].__setitem__(0,None))['status'], 'BLOCKED')

    def test_reject_missing_file(self):
        self.assertEqual(core.validate_workplan(self.root/'absent.json')['status'],'BLOCKED')

    def test_reject_duplicate_json_keys(self):
        path=self.root/'dup.json'
        path.write_text('{"tasks":[],"tasks":[]}',encoding='utf-8')
        self.assertEqual(core.validate_workplan(path)['status'],'BLOCKED')

    def test_reject_symlink_plan(self):
        path=self.put('good.json', ORIGINAL_PLAN)
        link=self.root/'link.json'; link.symlink_to(path)
        self.assertEqual(core.validate_workplan(link)['status'],'BLOCKED')


class GitSnapshotTests(Setup):
    def test_six_sources_seen(self):
        x=self.snapshots()
        self.assertEqual(len(x['observations']),6)
        self.assertEqual(x['confirmed_team_mappings'],0)

    def test_actual_head_change_recorded(self):
        x=self.snapshots()
        self.assertEqual(x['changed_count'],1)
        self.assertEqual(next(v for v in x['observations'] if v['status']=='COMMIT_CHANGED')['repo'],
                         'osmanosmanov6880-bot/osgard-world')

    def test_snapshot_comparison_not_production_approval(self):
        self.assertEqual(self.snapshots()['status'], 'OBSERVATIONAL_DIFF_ONLY')

    def test_invalid_sha(self):
        x=self.snapshots(lambda a,b: b['observed_repositories'][0].update(observed_head_sha='wrong'))
        self.assertEqual(x['status'],'BLOCKED')

    def test_invalid_repo(self):
        x=self.snapshots(lambda a,b: b['observed_repositories'][0].update(repo='evil.github.org/not-allowed'))
        self.assertEqual(x['status'],'BLOCKED')

    def test_duplicate_repo(self):
        x=self.snapshots(lambda a,b: b['observed_repositories'].append(copy.deepcopy(b['observed_repositories'][0])))
        self.assertEqual(x['status'],'BLOCKED')

    def test_branch_changed(self):
        x=self.snapshots(lambda a,b: b['observed_repositories'][0].update(branch='experiment'))
        self.assertIn('BRANCH_CHANGED', [r['status'] for r in x['observations']])

    def test_invalid_branch(self):
        x=self.snapshots(lambda a,b: b['observed_repositories'][0].update(branch='../secret'))
        self.assertEqual(x['status'],'BLOCKED')

    def test_disallow_unverified_team_assignment(self):
        x=self.snapshots(lambda a,b: b['observed_repositories'][0].update(team_assignment='TITAN'))
        self.assertEqual(x['status'],'BLOCKED')

    def test_new_repo_is_observation_only(self):
        x=self.snapshots(lambda a,b: b['observed_repositories'].append({
            'repo':'foo/bar','branch':'main','observed_head_sha':'a'*40,'team_assignment':None}))
        self.assertIn('NEWLY_OBSERVED',[r['status'] for r in x['observations']])

    def test_deleted_repo_is_unobserved(self):
        x=self.snapshots(lambda a,b: b['observed_repositories'].pop())
        self.assertIn('NOT_OBSERVED_NOW',[r['status'] for r in x['observations']])

    def test_missing_snapshot_file(self):
        x=core.compare_git_observations('nope',self.put('cur.json',CURRENT))
        self.assertEqual(x['status'],'BLOCKED')

    def test_empty_snapshot(self):
        x=self.snapshots(lambda a,b: b.update(observed_repositories=[]))
        self.assertEqual(x['status'],'BLOCKED')


class EvidenceTests(Setup):
    def test_no_index(self):
        x=core.inspect_local_evidence(self.root/'missing.json', self.root)
        self.assertEqual(x['status'],'BLOCKED')

    def test_empty_index(self):
        x=core.inspect_local_evidence(self.put('index.json',{'items':[]}),self.root)
        self.assertEqual(x['status'],'LOCAL_ARTIFACTS_STAGED_NOT_INDEPENDENTLY_VERIFIED')

    def test_valid_evidence_does_not_accept_gate(self):
        data=b'this is user submitted unreviewed data'
        (self.root/'evidence.txt').write_bytes(data)
        idx=self.put('index.json',{'items':[{'gate_id':'SEC-02','relative_path':'evidence.txt',
                                            'sha256':hashlib.sha256(data).hexdigest()}]})
        x=core.inspect_local_evidence(idx,self.root)
        self.assertEqual(x['staged'][0]['status'],'PRESENT_LOCAL_UNVERIFIED')
        self.assertEqual(x['status'],'LOCAL_ARTIFACTS_STAGED_NOT_INDEPENDENTLY_VERIFIED')

    def test_tampered_evidence_rejected(self):
        (self.root/'evidence.txt').write_bytes(b'not matching')
        idx=self.put('index.json',{'items':[{'gate_id':'SEC-02','relative_path':'evidence.txt','sha256':'a'*64}]})
        self.assertEqual(core.inspect_local_evidence(idx,self.root)['status'],'BLOCKED')

    def test_traversal_rejected(self):
        idx=self.put('index.json',{'items':[{'gate_id':'SEC-02','relative_path':'../etc/passwd','sha256':'a'*64}]})
        self.assertEqual(core.inspect_local_evidence(idx,self.root)['rejected'][0]['reason'],'UNSAFE_RELATIVE_PATH')

    def test_absolute_path_rejected(self):
        idx=self.put('index.json',{'items':[{'gate_id':'SEC-02','relative_path':'/etc/passwd','sha256':'a'*64}]})
        self.assertEqual(core.inspect_local_evidence(idx,self.root)['rejected'][0]['reason'],'UNSAFE_RELATIVE_PATH')

    def test_symlink_rejected(self):
        src=self.root/'evidence.txt'; src.write_bytes(b'abc')
        (self.root/'alias.txt').symlink_to(src)
        idx=self.put('index.json',{'items':[{'gate_id':'SEC-02','relative_path':'alias.txt',
                                            'sha256':hashlib.sha256(b'abc').hexdigest()}]})
        self.assertEqual(core.inspect_local_evidence(idx,self.root)['status'],'BLOCKED')

    def test_root_symlink_rejected(self):
        target=self.root/'dir';target.mkdir()
        alias=self.root/'alias';alias.symlink_to(target,target_is_directory=True)
        x=core.inspect_local_evidence(self.put('index.json',{'items':[]}),alias)
        self.assertEqual(x['status'],'BLOCKED')

    def test_duplicate_gate_rejected(self):
        data=b'abc';(self.root/'proof.txt').write_bytes(data)
        item={'gate_id':'SEC-02','relative_path':'proof.txt','sha256':hashlib.sha256(data).hexdigest()}
        idx=self.put('index.json',{'items':[item,item]})
        self.assertEqual(core.inspect_local_evidence(idx,self.root)['status'],'BLOCKED')

    def test_unknown_gate_rejected(self):
        idx=self.put('index.json',{'items':[{'gate_id':'CUSTOM','relative_path':'x','sha256':'a'*64}]})
        self.assertEqual(core.inspect_local_evidence(idx,self.root)['status'],'BLOCKED')

    def test_invalid_evidence_schema(self):
        idx=self.put('index.json',{'items':{}})
        self.assertEqual(core.inspect_local_evidence(idx,self.root)['status'],'BLOCKED')

    def test_invalid_digest(self):
        idx=self.put('index.json',{'items':[{'gate_id':'SEC-02','relative_path':'x','sha256':'!!'}]})
        self.assertEqual(core.inspect_local_evidence(idx,self.root)['status'],'BLOCKED')

    def test_oversized_file_rejected(self):
        path=self.root/'large.txt';path.write_bytes(b'1234')
        idx=self.put('index.json',{'items':[{'gate_id':'SEC-02','relative_path':'large.txt',
                                            'sha256':hashlib.sha256(b'1234').hexdigest()}]})
        with mock.patch.object(core,'MAX_EVIDENCE_BYTES',1):
            self.assertEqual(core.inspect_local_evidence(idx,self.root)['status'],'BLOCKED')


class IntegrationTests(Setup):
    def make_report(self):
        return core.build_report(ARCHIVE,
                ROOT/'docs/M182_WORKPLAN_180_PROPOSED.json',
                ROOT/'docs/SOURCE_PROVENANCE_RECONCILIATION.json',
                ROOT/'docs/m183/CURRENT_GITHUB_DEFAULT_BRANCH_OBSERVATIONS_2026-10-27.json')

    def test_parent_zip_matches_exact_sha(self):
        v=core.inspect_m182_package(ARCHIVE)
        self.assertEqual(v['status'],'LOCAL_BYTES_VERIFIED')
        self.assertEqual(v['sha256'],core.M182_ARCHIVE_SHA256)

    def test_parent_zip_fails_missing(self):
        self.assertEqual(core.inspect_m182_package(self.root/'missing.zip')['status'],'BLOCKED')

    def test_parent_zip_fails_forged(self):
        p=self.root/'forged.zip';p.write_bytes(b'forgery')
        self.assertEqual(core.inspect_m182_package(p)['status'],'BLOCKED')

    def test_original_m181_is_explicitly_blocked(self):
        self.assertEqual(self.make_report()['engineering']['m181_original']['status'],'BLOCKED')

    def test_never_production_go(self):
        self.assertEqual(self.make_report()['decision'],'PRODUCTION_NO_GO')

    def test_never_claim_world_leadership(self):
        self.assertEqual(self.make_report()['best_in_world_claim'],'UNPROVEN')

    def test_catalog_has_32_unique_requirements(self):
        self.assertEqual(len(criteria.GATES),32)
        self.assertEqual(len({x['id'] for x in criteria.GATES}),32)

    def test_no_self_reported_independent_success(self):
        r=self.make_report()
        self.assertEqual(r['world_readiness']['independently_verified'],0)
        self.assertEqual(r['original_tasks_independently_accepted_with_evidence'],0)

    def test_reconciled_snapshot_still_not_canonical_team(self):
        self.assertEqual(self.make_report()['engineering']['github_observations']['confirmed_team_mappings'],0)

    def test_report_markdown_contains_proper_no_go(self):
        self.assertIn('PRODUCTION_NO_GO',core.to_markdown(self.make_report()))

    def test_write_new_refuses_overwrite(self):
        p=self.root/'out.txt'
        core.write_new(p,'first')
        with self.assertRaises(FileExistsError):core.write_new(p,'second')
        self.assertEqual(p.read_text(),'first')

    def test_write_new_refuses_parent_symlink(self):
        target=self.root/'target';target.mkdir();link=self.root/'shortcut';link.symlink_to(target,target_is_directory=True)
        with self.assertRaises(ValueError):core.write_new(link/'out.txt','x')

    def test_dashboard_data_is_html_safe(self):
        r=self.make_report()
        r['product']='</script><script>alert(1)</script>'
        html=dashboard.render_html(r)
        self.assertNotIn('</script><script>alert(1)',html)
        self.assertIn('\\u003c/script\\u003e',html)

    def test_dashboard_contains_valid_title(self):
        self.assertIn('OSGARD // Engineering Control',dashboard.render_html(self.make_report()))

    def test_dashboard_marker_unique(self):
        bad=self.root/'bad.html';bad.write_text('no placeholder')
        with self.assertRaises(ValueError):dashboard.render_html(self.make_report(),bad)

    def test_cli_exits_two_on_no_go_and_writes_reports(self):
        flags=['assess','--m182-archive',str(ARCHIVE),
          '--workplan',str(ROOT/'docs/M182_WORKPLAN_180_PROPOSED.json'),
          '--old-observations',str(ROOT/'docs/SOURCE_PROVENANCE_RECONCILIATION.json'),
          '--current-observations',str(ROOT/'docs/m183/CURRENT_GITHUB_DEFAULT_BRANCH_OBSERVATIONS_2026-10-27.json'),
          '--json-out',str(self.root/'out.json'),'--md-out',str(self.root/'out.md'),
          '--html-out',str(self.root/'out.html')]
        with mock.patch('builtins.print'):
            self.assertEqual(main(flags),2)
        self.assertTrue((self.root/'out.json').exists())
        self.assertTrue((self.root/'out.md').exists())
        self.assertTrue((self.root/'out.html').exists())
        with mock.patch('builtins.print'):
            self.assertEqual(main(flags),3)

    def test_dashboard_invalid_marker_prevents_substitution(self):
        t=self.root/'double.html';t.write_text('x __REPORT_JSON__ y __REPORT_JSON__')
        with self.assertRaises(ValueError):dashboard.render_html(self.make_report(),t)


if __name__ == '__main__':
    unittest.main()
