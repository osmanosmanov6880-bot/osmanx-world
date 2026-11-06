"""M198 finance regression: money, identity, immutability and failure tests.

All balances and claims here are synthetic; no bank or network is contacted.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
from pathlib import Path
import tempfile
import unittest
import uuid

from osgard_m192.runtime import Invalid, Conflict, Unauthorized
from osgard_m197.runtime import Director197
from osgard_m198.runtime import Director198


def key(): return 'm198-' + uuid.uuid4().hex


class FinanceTests(unittest.TestCase):
    def setUp(self):
        t=tempfile.TemporaryDirectory(prefix='m198-finance-')
        self.addCleanup(t.cleanup)
        self.path=Path(t.name)/'finance.sqlite'
        self.now=[1_800_000_000]
        self.app=Director198(self.path,clock=lambda:self.now[0]);self.app.initialize()
        self.owner=self.app.provision('Organization A','boss')['token']
        self.staff=self.app.issue_token(self.owner,'sales','operator')['token']
        self.viewer=self.app.issue_token(self.owner,'reader','viewer')['token']
        self.foreign=self.app.provision('Organization B','other')['token']
        self.customer=self.call('commerce.customers.create',{'name':'Client A','contact':'@a'},write=True)['id']
        self.deal=self.call('commerce.deals.create',{'customer_id':self.customer,'title':'Site','amount_minor':1_500_000,'stage':'new'},write=True)['id']
        self.project=self.call('commerce.projects.create',{'deal_id':self.deal,'title':'Site build'},write=True)['id']
        self.pid=self.project

    def call(self,op,p=None,token=None,write=False,idem=None):
        return self.app.execute(token or self.owner,op,p or {},idem if idem is not None else (key() if write else None))

    def base(self,p=None):return {'project_id':self.pid,**(p or {})}

    def budget(self,amount=900_000,version=0,**kwargs):
        return self.call('commerce.finance.budget.set',self.base({'expected_version':version,'budget_minor':amount,**kwargs}),write=True)

    def expense(self,amount=100_000,kind='planned',category='services',token=None):
        return self.call('commerce.finance.expenses.add',self.base({'title':'Designer','category':category,'kind':kind,'amount_minor':amount}),token,True)

    def receivable(self,amount=500_000,due_at=None,**other):
        return self.call('commerce.finance.receivables.add',self.base({'title':'Payment milestone','amount_minor':amount,
                         **({'due_at':due_at} if due_at is not None else {}),**other}),write=True)

    def snapshot(self,token=None):
        return self.call('commerce.finance.snapshot',self.base(),token)

    def doc(self,data=b'Local synthetic receipt'):
        card=self.call('commerce.projects.get',self.base())
        return self.call('commerce.projects.documents.add',self.base({
            'expected_project_version':card['project']['version'],'name':'Receipt.txt',
            'mime':'text/plain','base64':base64.b64encode(data).decode('ascii')}),write=True)

    def test_initial_budget_unknown_not_zero(self):
        s=self.snapshot()['summary']
        self.assertIsNone(s['budget_minor'])
        self.assertIsNone(s['forecast_variance_minor'])
        self.assertEqual(s['risk'],'BUDGET_NOT_SET')
        self.assertFalse(s['external_bank_verified'])

    def test_set_budget_integer_kopecks(self):
        self.assertEqual(self.budget()['version'],1)
        s=self.snapshot()['summary'];self.assertEqual(s['budget_minor'],900_000)
        self.assertEqual(s['budget_version'],1);self.assertEqual(s['currency'],'RUB')

    def test_budget_version_updates(self):
        self.budget();self.budget(amount=1_000_000,version=1)
        self.assertEqual(self.snapshot()['summary']['budget_version'],2)
        self.assertEqual(self.snapshot()['summary']['budget_minor'],1_000_000)

    def test_budget_conflict_and_unchanged(self):
        self.budget()
        with self.assertRaises(Conflict):self.budget(amount=20,version=0)
        with self.assertRaises(Conflict):self.budget(amount=900_000,version=1)

    def test_concurrent_budget_optimistic_lock(self):
        self.budget()
        def update(i):
            try:self.budget(900_000+i,version=1);return 'ok'
            except Conflict:return 'stale'
        with ThreadPoolExecutor(max_workers=8) as pool:out=list(pool.map(update,range(1,9)))
        self.assertEqual(out.count('ok'),1)
        self.assertEqual(out.count('stale'),7)
        self.assertEqual(self.snapshot()['summary']['budget_version'],2)

    def test_money_reject_bool_float_negative_and_overflow(self):
        for value in (True,12.5,-1,10**12+1,'1000',None):
            with self.subTest(value=value),self.assertRaises(Invalid):self.budget(amount=value)
        for value in (False,0,-1,4.6,10**12+1):
            with self.subTest(expense=value),self.assertRaises(Invalid):self.expense(amount=value)

    def test_zero_budget_and_forecast(self):
        self.budget(0)
        self.expense(5_000)
        s=self.snapshot()['summary']
        self.assertEqual(s['forecast_over_budget_minor'],5000)
        self.assertIsNone(s['budget_usage_basis_points'])
        self.assertEqual(s['risk'],'OVER_BUDGET')

    def test_planned_actual_and_forecast(self):
        self.budget(800_000)
        self.expense(80_000,'incurred');self.expense(120_000,'planned')
        s=self.snapshot()['summary']
        self.assertEqual(s['actual_cost_minor'],80000)
        self.assertEqual(s['planned_cost_minor'],120000)
        self.assertEqual(s['forecast_cost_minor'],200000)
        self.assertEqual(s['forecast_variance_minor'],-600000)
        self.assertEqual(s['budget_usage_basis_points'],1000)
        self.assertEqual(s['risk'],'ON_PLAN')

    def test_expense_commit_planned_to_incurred(self):
        record=self.expense(123_00)
        result=self.call('commerce.finance.expenses.commit',self.base({'expense_id':record['id'],'expected_version':1}),write=True)
        self.assertEqual(result['kind'],'incurred');self.assertEqual(result['version'],2)
        s=self.snapshot()['summary']
        self.assertEqual(s['actual_cost_minor'],12300)
        self.assertEqual(s['planned_cost_minor'],0)
        with self.assertRaises(Conflict):self.call('commerce.finance.expenses.commit',self.base({'expense_id':record['id'],'expected_version':2}),write=True)

    def test_void_expense_requires_reason_and_audit(self):
        record=self.expense(2_500,kind='incurred')
        with self.assertRaises(Invalid):self.call('commerce.finance.expenses.void',self.base({'expense_id':record['id'],'expected_version':1,'reason':''}),write=True)
        result=self.call('commerce.finance.expenses.void',self.base({'expense_id':record['id'],'expected_version':1,'reason':'Correction'}),write=True)
        self.assertEqual(result['state'],'voided')
        self.assertEqual(self.snapshot()['summary']['actual_cost_minor'],0)
        events=self.call('commerce.finance.history',self.base())['events']
        self.assertIn('finance_expense_voided',[e['kind'] for e in events])

    def test_stale_expense_or_duplicate_void(self):
        rec=self.expense()
        self.call('commerce.finance.expenses.void',self.base({'expense_id':rec['id'],'expected_version':1,'reason':'Reversed'}),write=True)
        with self.assertRaises(Conflict):self.call('commerce.finance.expenses.void',self.base({'expense_id':rec['id'],'expected_version':1,'reason':'Again'}),write=True)

    def test_no_foreign_expenses(self):
        rec=self.expense()
        with self.assertRaises(Invalid):self.call('commerce.finance.expenses.commit',self.base({'expense_id':rec['id'],'expected_version':1}),token=self.foreign,write=True)

    def test_invalid_categories(self):
        for category,kind in [('bad','planned'),('labor','other'),([], 'planned')]:
            with self.subTest(category=category,kind=kind),self.assertRaises((Invalid,TypeError)):
                self.expense(category=category,kind=kind)

    def test_receivable_pending_overdue_and_risk(self):
        self.budget()
        r=self.receivable(700_000,self.now[0]-100)
        s=self.snapshot()['summary']
        self.assertEqual(s['overdue_receivables_count'],1)
        self.assertEqual(s['pending_receivables_minor'],700000)
        self.assertEqual(s['risk'],'RECEIVABLE_OVERDUE')
        self.assertEqual(r['state'],'pending')

    def test_receivable_requires_document_to_record(self):
        r=self.receivable()
        with self.assertRaises((Invalid,Conflict)):
            self.call('commerce.finance.receivables.resolve',self.base({'receivable_id':r['id'],'expected_version':1,'state':'recorded','evidence_sha256':'a'*64,'evidence_document_id':'missing'}),write=True)
        self.assertEqual(self.snapshot()['summary']['manually_recorded_receivables_minor'],0)

    def test_manual_receipt_document_proof_current_version(self):
        r=self.receivable(280_000)
        d=self.doc()
        result=self.call('commerce.finance.receivables.resolve',self.base({'receivable_id':r['id'],'expected_version':1,'state':'recorded','evidence_document_id':d['id'],'evidence_sha256':d['sha256']}),write=True)
        self.assertEqual(result['state'],'recorded')
        self.assertFalse(result['external_bank_verified'])
        summary=self.snapshot()['summary']
        self.assertEqual(summary['manually_recorded_receivables_minor'],280_000)
        self.assertEqual(summary['pending_receivables_minor'],0)
        self.assertFalse(summary['real_payment_executed'])

    def test_stale_receipt_evidence_rejected(self):
        r=self.receivable();d=self.doc()
        self.call('commerce.projects.documents.revise',self.base({'document_id':d['id'],'expected_version':1,
          'base64':base64.b64encode(b'Revised receipt').decode('ascii')}),write=True)
        with self.assertRaises(Conflict):self.call('commerce.finance.receivables.resolve',self.base({'receivable_id':r['id'],'expected_version':1,'state':'recorded','evidence_document_id':d['id'],'evidence_sha256':d['sha256']}),write=True)

    def test_foreign_project_document_cannot_prove_receipt(self):
        r=self.receivable();d=self.doc()
        project2=self.call('commerce.projects.create',{'deal_id':self.deal,'title':'Second'},write=True)
        with self.assertRaises((Invalid,Conflict)):
            self.call('commerce.finance.receivables.resolve',{'project_id':project2['id'],'receivable_id':r['id'],'expected_version':1,'state':'recorded','evidence_document_id':d['id'],'evidence_sha256':d['sha256']},write=True)

    def test_cancel_receivable_and_no_double_resolution(self):
        r=self.receivable(700000)
        p=self.base({'receivable_id':r['id'],'expected_version':1,'state':'cancelled','reason':'Client withdrew'})
        self.assertEqual(self.call('commerce.finance.receivables.resolve',p,write=True)['state'],'cancelled')
        self.assertEqual(self.snapshot()['summary']['expected_receivables_minor'],0)
        with self.assertRaises(Conflict):self.call('commerce.finance.receivables.resolve',p,write=True)

    def test_receivable_stage_same_project(self):
        proj=self.call('commerce.projects.get',self.base())['project']
        st=self.call('commerce.projects.stage.add',self.base({'expected_version':proj['version'],'title':'Review'}),write=True)
        r=self.receivable(stage_id=st['id']);self.assertEqual(r['version'],1)
        with self.assertRaises(Invalid):self.receivable(stage_id='foreign-stage')

    def test_idempotency_exact_replay(self):
        k=key();p=self.base({'title':'Audit','category':'labor','amount_minor':100_000,'kind':'planned'})
        first=self.call('commerce.finance.expenses.add',p,write=True,idem=k)
        second=self.call('commerce.finance.expenses.add',p,write=True,idem=k)
        self.assertEqual(first,second)
        self.assertEqual(len(self.snapshot()['expenses']),1)
        with self.assertRaises(Conflict):self.call('commerce.finance.expenses.add',{**p,'amount_minor':110000},write=True,idem=k)

    def test_idempotency_no_key(self):
        with self.assertRaises(Invalid):self.call('commerce.finance.budget.set',self.base({'expected_version':0,'budget_minor':100}),write=False)

    def test_unauthorized_viewer(self):
        with self.assertRaises(Unauthorized):self.snapshot(self.viewer)
        with self.assertRaises(Unauthorized):self.budget_by_token(self.viewer)

    def budget_by_token(self,token):
        return self.call('commerce.finance.budget.set',self.base({'expected_version':0,'budget_minor':100}),token,True)

    def test_operator_creator_allowed_only_own_project(self):
        d=self.call('commerce.projects.create',{'deal_id':self.deal,'title':'Staff project'},token=self.staff,write=True)
        allowed=self.call('commerce.finance.snapshot',{'project_id':d['id']},token=self.staff)
        self.assertEqual(allowed['summary']['budget_version'],0)
        with self.assertRaises(Unauthorized):self.snapshot(self.staff)
        with self.assertRaises(Unauthorized):self.call('commerce.finance.expenses.add',self.base({'title':'X','category':'services','amount_minor':100,'kind':'planned'}),self.staff,True)

    def test_tenant_isolation_read_and_write(self):
        with self.assertRaises(Invalid):self.snapshot(self.foreign)
        with self.assertRaises(Invalid):self.call('commerce.finance.budget.set',self.base({'expected_version':0,'budget_minor':200}),self.foreign,True)

    def test_closed_project_readonly(self):
        p=self.call('commerce.projects.get',self.base())['project']
        s=self.call('commerce.projects.stage.add',self.base({'expected_version':p['version'],'title':'Finish'}),write=True)
        p=self.call('commerce.projects.get',self.base())['project']
        self.call('commerce.projects.status',self.base({'expected_version':p['version'],'state':'active'}),write=True)
        self.call('commerce.projects.stage.status',self.base({'stage_id':s['id'],'expected_version':1,'status':'active'}),write=True)
        self.call('commerce.projects.stage.status',self.base({'stage_id':s['id'],'expected_version':2,'status':'done'}),write=True)
        p=self.call('commerce.projects.get',self.base())['project']
        self.call('commerce.projects.status',self.base({'expected_version':p['version'],'state':'completed'}),write=True)
        with self.assertRaises(Conflict):self.budget()
        self.assertEqual(self.snapshot()['summary']['risk'],'BUDGET_NOT_SET')

    def test_card_contains_finance_for_owner_only(self):
        self.budget()
        self.assertEqual(self.call('commerce.projects.card',self.base())['finance_summary']['budget_minor'],900000)
        view=self.call('commerce.projects.card',self.base(),self.viewer)
        self.assertNotIn('finance_summary',view)

    def test_history_tampering_refused_before_write(self):
        self.budget()
        with self.app.connect() as db:
            db.execute('DROP TRIGGER IF EXISTS delivery_events_immutable_update')
            db.execute('UPDATE delivery_events SET event_hash=? WHERE kind=?',( '0'*64,'finance_budget_set'))
        with self.assertRaises(Conflict):self.expense()

    def test_rollback_on_invalid_doc_keeps_pending(self):
        r=self.receivable();before=self.snapshot()['summary']['pending_receivables_minor']
        with self.assertRaises((Invalid,Conflict)):
            self.call('commerce.finance.receivables.resolve',self.base({'receivable_id':r['id'],'expected_version':1,'state':'recorded','evidence_document_id':'z','evidence_sha256':'0'*64}),write=True)
        after=self.snapshot()['summary']['pending_receivables_minor']
        self.assertEqual(before,after)

    def test_migration_from_m197_no_data_loss(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'old.sqlite';old=Director197(path);old.initialize();token=old.provision('Org','boss')['token']
            before=old.execute(token,'titan.session.get',{})
            new=Director198(path);new.initialize()
            self.assertEqual(new.execute(token,'titan.session.get',{}),before)
            with new.connect() as db:
                self.assertIn('delivery_finance_budgets', {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")})


if __name__=='__main__':unittest.main()
