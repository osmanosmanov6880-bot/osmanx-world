"""M200 adversarial regression on real M192-M199 SQLite, all synthetic money."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
import uuid

from osgard_m192.runtime import Invalid, Conflict, Unauthorized
from osgard_m199.runtime import Director199
from osgard_m200.runtime import Director200


def key():
    return 'm200-' + uuid.uuid4().hex


class CashflowTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory(prefix='osgard-m200-')
        self.addCleanup(tmp.cleanup)
        self.path=Path(tmp.name)/'finance.sqlite'
        self.now=[1799971200]  # 2027-01-15 UTC
        self.app=Director200(self.path,clock=lambda:self.now[0])
        self.app.initialize()
        self.owner=self.app.provision('Company A','boss')['token']
        self.operator=self.app.issue_token(self.owner,'sales','operator')['token']
        self.viewer=self.app.issue_token(self.owner,'observer','viewer')['token']
        self.other=self.app.provision('Company B','other')['token']
        self.project=self.create_project(self.owner,'Project A')
        self.op_project=self.create_project(self.operator,'Project B')
        self.other_project=self.create_project(self.other,'Foreign')

    def call(self,op,p=None,token=None,write=False,idem=None):
        return self.app.execute(token or self.owner,op,p or {},
                                idem if idem is not None else key() if write else None)

    def create_project(self,token,title):
        customer=self.call('commerce.customers.create',
                           {'name':title+' Client','contact':'none'},
                           token,True)['id']
        deal=self.call('commerce.deals.create',
                       {'customer_id':customer,'title':title,
                        'amount_minor':900000,'stage':'new'},token,True)['id']
        return self.call('commerce.projects.create',
                         {'deal_id':deal,'title':title},token,True)['id']

    def expense(self,amount=20000,pid=None,token=None,kind='planned'):
        return self.call('commerce.finance.expenses.add',
            {'project_id':pid or self.project,'title':'Development',
             'kind':kind,'amount_minor':amount,'category':'labor'},token,True)

    def income(self,amount=30000,when=None,pid=None,token=None):
        params={'project_id':pid or self.project,'title':'Expected payment',
                'amount_minor':amount}
        if when is not None:params['due_at']=when
        return self.call('commerce.finance.receivables.add',params,token,True)

    def schedule(self,expense,pid=None,when=None,token=None,version=0,idem=None):
        return self.call('commerce.cashflow.schedule.set',
            {'project_id':pid or self.project,'expense_id':expense['id'],
             'expected_expense_version':expense['version'],
             'expected_schedule_version':version,'due_at':when or self.now[0]+3600},
            token,True,idem)

    def forecast(self,p=None,token=None):
        return self.call('commerce.cashflow.forecast',p,token)

    def test_initial_zero_forecast_with_hypothetical_opening(self):
        data=self.forecast()
        self.assertEqual(data['project_count'],2)
        self.assertEqual(data['ending_balance_minor'],0)
        self.assertEqual(data['risk'],'NO_GAP_IN_MODEL')
        self.assertFalse(data['bank_verified'])
        self.assertFalse(data['production_authorized'])
        self.assertEqual(len(data['buckets']),6)

    def test_schedule_real_sqlite_and_reopen(self):
        e=self.expense()
        result=self.schedule(e)
        self.assertEqual(result['schedule_version'],1)
        self.assertFalse(result['external_payment_executed'])
        new=Director200(self.path,clock=lambda:self.now[0])
        new.initialize()
        schedule=new.execute(self.owner,'commerce.cashflow.schedule.list',
                             {'project_id':self.project})
        self.assertEqual(schedule['items'][0]['due_at'],self.now[0]+3600)

    def test_future_inflow_and_outflow_net(self):
        e=self.expense(10000)
        self.schedule(e)
        self.income(15000,self.now[0]+3600)
        result=self.forecast({'months':1})
        b=result['buckets'][0]
        self.assertEqual(b['expected_inflow_minor'],15000)
        self.assertEqual(b['expected_outflow_minor'],10000)
        self.assertEqual(b['closing_balance_minor'],5000)
        self.assertEqual(result['risk'],'NO_GAP_IN_MODEL')

    def test_detect_gap_and_first_gap_month(self):
        e=self.expense(20000);self.schedule(e)
        self.income(10000,self.now[0]+3600)
        result=self.forecast({'months':1})
        self.assertEqual(result['first_gap_month'],'2027-01')
        self.assertEqual(result['lowest_balance_minor'],-10000)
        self.assertEqual(result['buckets'][0]['cash_gap_minor'],10000)
        self.assertEqual(result['risk'],'MODELED_GAP')

    def test_monthly_scoping(self):
        e=self.expense(10000);self.schedule(e,when=self.now[0]+40*86400)
        self.income(15000,self.now[0]+3600)
        result=self.forecast({'months':3})
        self.assertEqual([b['month'] for b in result['buckets']],
                         ['2027-01','2027-02','2027-03'])
        self.assertEqual(result['buckets'][0]['closing_balance_minor'],15000)
        self.assertEqual(result['buckets'][1]['closing_balance_minor'],5000)
        self.assertIsNone(result['first_gap_month'])

    def test_unplanned_dates_are_explicitly_excluded(self):
        self.expense(10000)
        self.income(20000)
        result=self.forecast()
        self.assertEqual(result['outside_horizon']['undated_outflow_minor'],10000)
        self.assertEqual(result['outside_horizon']['undated_inflow_minor'],20000)
        self.assertFalse(result['complete_expense_schedule'])
        self.assertEqual(result['risk'],'INCOMPLETE_DATES')
        self.assertEqual(result['ending_balance_minor'],0)

    def test_overdue_classified_outside_future(self):
        e=self.expense(10000);self.schedule(e,when=self.now[0]-1000)
        self.income(30000,self.now[0]-1000)
        r=self.forecast()
        self.assertEqual(r['outside_horizon']['overdue_outflow_minor'],10000)
        self.assertEqual(r['outside_horizon']['overdue_inflow_minor'],30000)
        self.assertEqual(r['risk'],'OVERDUE_OUTSIDE_MODEL')
        self.assertEqual(r['ending_balance_minor'],0)

    def test_beyond_horizon_reconciles(self):
        e=self.expense(10000);self.schedule(e,when=self.now[0]+400*86400)
        self.income(30000,self.now[0]+400*86400)
        r=self.forecast({'months':2})
        self.assertEqual(r['outside_horizon']['beyond_horizon_outflow_minor'],10000)
        self.assertEqual(r['outside_horizon']['beyond_horizon_inflow_minor'],30000)
        self.assertEqual(r['totals']['planned_outflow_minor'],10000)

    def test_already_incurred_not_subtracted_again(self):
        e=self.expense(14000,kind='incurred')
        self.income(20000,self.now[0]+3600)
        r=self.forecast({'months':1})
        self.assertEqual(r['totals']['already_incurred_minor'],14000)
        self.assertEqual(r['ending_balance_minor'],20000)

    def test_collection_rate_conservative(self):
        self.income(10001,self.now[0]+3600)
        r=self.forecast({'months':1,'collection_rate_bp':5000})
        self.assertEqual(r['buckets'][0]['expected_inflow_minor'],5001)
        self.assertEqual(r['scenario']['collection_rate_bp'],5000)

    def test_cost_overrun_scenario(self):
        e=self.expense(10001);self.schedule(e)
        r=self.forecast({'months':1,'cost_overrun_bp':2500})
        self.assertEqual(r['buckets'][0]['expected_outflow_minor'],12501)

    def test_comparison_three_scenarios(self):
        e=self.expense(10000);self.schedule(e)
        self.income(10000,self.now[0]+3600)
        scenarios=[
            {'label':'Обычный','starting_balance_minor':5000},
            {'label':'Строгий','collection_rate_bp':3000},
            {'label':'Рост затрат','cost_overrun_bp':4000},
        ]
        r=self.call('commerce.cashflow.compare',{'months':1,'scenarios':scenarios})
        self.assertEqual(len(r['scenarios']),3)
        self.assertEqual(r['scenarios'][0]['ending_balance_minor'],5000)
        self.assertEqual(r['scenarios'][1]['ending_balance_minor'],-7000)
        self.assertEqual(r['scenarios'][2]['ending_balance_minor'],-4000)
        self.assertFalse(r['bank_verified'])

    def test_reject_duplicate_scenario_labels(self):
        s=[{'label':'A'},{'label':'A'}]
        with self.assertRaises(Invalid):
            self.call('commerce.cashflow.compare',{'scenarios':s})

    def test_reject_invalid_parameters(self):
        bad=[
            {'months':0},{'months':19},{'months':True},{'months':2.5},
            {'starting_balance_minor':True},{'starting_balance_minor':10**18},
            {'collection_rate_bp':10001},{'collection_rate_bp':-1},
            {'cost_overrun_bp':'500'},{'project_state':'unknown'},
            {'as_of':None},{'untrusted':123},
        ]
        for payload in bad:
            with self.subTest(payload=payload),self.assertRaises(Invalid):
                self.forecast(payload)

    def test_tenant_isolation(self):
        self.income(50000,self.now[0]+100)
        other=self.forecast(token=self.other)
        self.assertEqual(other['totals']['pending_inflow_minor'],0)
        self.assertEqual(other['project_count'],1)

    def test_operator_only_owned_projects(self):
        e=self.expense(10000,pid=self.op_project,token=self.operator)
        self.schedule(e,pid=self.op_project,token=self.operator)
        self.income(30000,self.now[0]+100)
        r=self.forecast(token=self.operator)
        self.assertEqual(r['project_count'],1)
        self.assertEqual(r['totals']['pending_inflow_minor'],0)
        self.assertEqual(r['totals']['planned_outflow_minor'],10000)

    def test_viewer_denied(self):
        for op in ('commerce.cashflow.forecast','commerce.cashflow.compare',
                   'commerce.cashflow.schedule.list'):
            with self.subTest(op=op), self.assertRaises(Unauthorized):
                self.call(op,{'project_id':self.project} if op.endswith('list')
                          else {'scenarios':[{'label':'A'},{'label':'B'}]}
                          if op.endswith('compare') else {},self.viewer)

    def test_foreign_schedule_does_not_leak(self):
        e=self.expense()
        with self.assertRaises(Invalid):
            self.schedule(e,token=self.other)
        with self.assertRaises(Invalid):
            self.call('commerce.cashflow.schedule.list',
                {'project_id':self.project},self.other)

    def test_operator_cannot_schedule_other_project(self):
        e=self.expense()
        with self.assertRaises(Unauthorized):
            self.schedule(e,token=self.operator)

    def test_version_conflict(self):
        e=self.expense()
        self.schedule(e)
        with self.assertRaises(Conflict):
            self.schedule(e,when=self.now[0]+7500,version=0)
        updated=self.schedule(e,when=self.now[0]+7500,version=1)
        self.assertEqual(updated['schedule_version'],2)

    def test_idempotency_replay(self):
        e=self.expense();idem=key()
        one=self.schedule(e,idem=idem)
        two=self.schedule(e,idem=idem)
        self.assertEqual(one,two)
        with self.assertRaises(Conflict):
            self.schedule(e,when=self.now[0]+7200,idem=idem)

    def test_schedule_closes_when_expense_incurred(self):
        e=self.expense();self.schedule(e)
        self.call('commerce.finance.expenses.commit',
            {'project_id':self.project,'expense_id':e['id'],
             'expected_version':1},write=True)
        with self.assertRaises(Conflict):
            self.schedule(e,version=1)
        self.assertEqual(self.forecast()['totals']['already_incurred_minor'],20000)
        self.assertEqual(self.forecast()['totals']['planned_outflow_minor'],0)

    def test_no_schedule_on_closed_project(self):
        e=self.expense()
        self.call('commerce.projects.status',
            {'project_id':self.project,'expected_version':1,'state':'cancelled'},
            write=True)
        with self.assertRaises(Conflict):
            self.schedule(e)

    def test_schedule_requires_due_at_and_keys(self):
        e=self.expense()
        payload={'project_id':self.project,'expense_id':e['id'],
            'expected_expense_version':1,'expected_schedule_version':0,
            'due_at':None}
        with self.assertRaises(Conflict):
            self.call('commerce.cashflow.schedule.set',payload,write=True)
        with self.assertRaises(Invalid):
            self.app.execute(self.owner,'commerce.cashflow.schedule.set',payload,None)
        with self.assertRaises(Invalid):
            self.app.execute(self.owner,'commerce.cashflow.forecast',{},key())

    def test_read_only_does_not_add_audit(self):
        with self.app.connect() as db:
            before=db.execute('SELECT COUNT(*) FROM requests').fetchone()[0]
        self.forecast()
        self.call('commerce.cashflow.compare',
                  {'scenarios':[{'label':'A'},{'label':'B'}]})
        with self.app.connect() as db:
            after=db.execute('SELECT COUNT(*) FROM requests').fetchone()[0]
        self.assertEqual(before,after)

    def test_earlier_m199_apis_still_available(self):
        res=self.call('commerce.portfolio.overview')
        self.assertEqual(res['totals']['project_count'],2)

    def test_concurrent_schedule_single_version_wins(self):
        e=self.expense()
        def worker(i):
            try:
                self.schedule(e,when=self.now[0]+i*1800)
                return 'ok'
            except Conflict:
                return 'conflict'
        with ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(worker,range(1,9)))
        self.assertEqual(results.count('ok'),1)
        self.assertEqual(results.count('conflict'),7)


if __name__=='__main__':
    unittest.main()
