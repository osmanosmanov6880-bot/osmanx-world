"""M201 synthetic adversarial tests: alerts, dedup, lifecycle, RBAC, tasks."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

from osgard_m192.runtime import Invalid,Conflict,Unauthorized
from osgard_m200.runtime import Director200
from osgard_m201.runtime import Director201


def key():
    return 'm201-' + uuid.uuid4().hex


class AlertsTests(unittest.TestCase):
    def setUp(self):
        root=tempfile.TemporaryDirectory(prefix='m201-alerts-')
        self.addCleanup(root.cleanup)
        self.path=Path(root.name)/'test.sqlite'
        self.now=[1799971200]
        self.app=Director201(self.path,clock=lambda:self.now[0])
        self.app.initialize()
        self.owner=self.app.provision('Tenant One','owner')['token']
        self.operator=self.app.issue_token(self.owner,'engineer','operator')['token']
        self.viewer=self.app.issue_token(self.owner,'observer','viewer')['token']
        self.other=self.app.provision('Tenant Two','foreign')['token']
        self.project=self.project_create(self.owner)
        self.foreign_project=self.project_create(self.other)

    def call(self,op,p=None,token=None,write=False,idem=None):
        return self.app.execute(
            token or self.owner,op,{} if p is None else p,
            (idem if idem is not None else (key() if write else None))
        )

    def project_create(self,token):
        customer=self.call('commerce.customers.create',{'name':'Customer','contact':'none'},token,True)['id']
        deal=self.call('commerce.deals.create',{'customer_id':customer,'title':'Contract',
                  'amount_minor':900000,'stage':'new'},token,True)['id']
        return self.call('commerce.projects.create',{'deal_id':deal,'title':'Delivery'},token,True)['id']

    def expense(self, amount=30000, project=None, kind='planned',token=None):
        return self.call('commerce.finance.expenses.add',
            {'project_id':project or self.project,'title':'Monthly spend',
             'kind':kind,'category':'services','amount_minor':amount},token,True)

    def schedule(self,expense,project=None,when=None,token=None):
        return self.call('commerce.cashflow.schedule.set',{
            'project_id':project or self.project,'expense_id':expense['id'],
            'expected_expense_version':expense['version'],
            'expected_schedule_version':0,'due_at':when or self.now[0]+3600
        },token,True)

    def receipt(self, amount=12000, when=None):
        return self.call('commerce.finance.receivables.add',{
            'project_id':self.project,'title':'Expected invoice',
            'amount_minor':amount,'due_at':when},write=True)

    def policy(self,config=None,version=0,token=None,idem=None):
        return self.call('commerce.alerts.policy.set',
            {'config':{} if config is None else config,'expected_version':version},
            token,True,idem)

    def scan(self,version=1,token=None,idem=None):
        return self.call('commerce.alerts.scan',{'expected_policy_version':version},
                         token,True,idem)

    def alerts(self, status=None, token=None):
        return self.call('commerce.alerts.list',
            {'status':status} if status else {},token)['items']

    def cause_cash_gap(self):
        e=self.expense()
        self.schedule(e)
        return e

    def test_old_database_migrates_without_data_loss(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'old.sqlite'
            prev=Director200(path,clock=lambda:self.now[0]);prev.initialize()
            token=prev.provision('Legacy','legacy')['token']
            before=prev.execute(token,'titan.session.get',{})
            new=Director201(path,clock=lambda:self.now[0]);new.initialize()
            self.assertEqual(new.execute(token,'titan.session.get',{}),before)
            with new.connect() as db:
                names={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                self.assertIn('financial_alerts',names)
                self.assertIn('financial_alert_events',names)
                self.assertIn('financial_alert_policies',names)

    def test_no_policy_explicit_scan_denied(self):
        with self.assertRaises(Invalid):
            self.scan()

    def test_policy_defaults_and_read_back(self):
        self.policy()
        result=self.call('commerce.alerts.policy.get')
        self.assertTrue(result['exists'])
        self.assertEqual(result['version'],1)
        self.assertEqual(result['config']['months'],6)
        self.assertEqual(result['config']['collection_rate_bp'],10000)
        self.assertFalse(result['bank_verified'])

    def test_policy_versioned_update(self):
        self.policy()
        self.policy({'months':12,'min_balance_minor':10000},version=1)
        item=self.call('commerce.alerts.policy.get')
        self.assertEqual(item['config']['months'],12)
        self.assertEqual(item['version'],2)
        with self.assertRaises(Conflict):
            self.policy({'months':3},version=1)

    def test_policy_rejects_unchanged(self):
        self.policy()
        with self.assertRaises(Conflict):
            self.policy({},version=1)

    def test_policy_numeric_bool_float_and_overflow_rejected(self):
        for cfg in [
            {'months':True},{'months':0},{'months':19},
            {'min_balance_minor':-1},{'max_unscheduled_outflow_minor':False},
            {'max_overdue_inflow_minor':1.5},{'collection_rate_bp':10001},
            {'cost_overrun_bp':'100'},{'max_overbudget_projects':1001},
            {'starting_balance_minor':10**20},{'unexpected':1},
            {'project_state':'gone'}
        ]:
            with self.subTest(cfg=cfg),self.assertRaises(Invalid):
                self.policy(cfg)

    def test_owner_only_configure_preview_scan(self):
        for op,config in [
            ('commerce.alerts.policy.set',{'expected_version':0,'config':{}}),
            ('commerce.alerts.preview',{}),
            ('commerce.alerts.scan',{'expected_policy_version':1}),
            ('commerce.alerts.list',{}),
        ]:
            with self.subTest(op=op),self.assertRaises(Unauthorized):
                self.call(op,config,self.operator,op.endswith(('.set','.scan')))

    def test_viewer_denied_including_mine(self):
        self.policy()
        for op in ('commerce.alerts.policy.get','commerce.alerts.list',
                   'commerce.alerts.preview','commerce.alerts.mine'):
            with self.subTest(op=op),self.assertRaises(Unauthorized):
                self.call(op,token=self.viewer)

    def test_preview_readonly_without_side_effects(self):
        self.policy()
        self.cause_cash_gap()
        with self.app.connect() as db:
            before=db.execute('SELECT COUNT(*) FROM requests').fetchone()[0]
        output=self.call('commerce.alerts.preview')
        self.assertFalse(output['persisted'])
        self.assertEqual(output['policy_version'],1)
        self.assertEqual(len(output['rules']),5)
        self.assertIn('CASH_GAP',{r['rule'] for r in output['rules'] if r['present']})
        self.assertEqual(self.alerts(),[])
        with self.app.connect() as db:
            after=db.execute('SELECT COUNT(*) FROM requests').fetchone()[0]
        self.assertEqual(before,after)

    def test_cash_gap_creates_single_alert(self):
        self.policy()
        self.cause_cash_gap()
        response=self.scan()
        self.assertEqual(response['created_count'],1)
        alerts=self.alerts()
        self.assertEqual(alerts[0]['rule'],'CASH_GAP')
        self.assertEqual(alerts[0]['severity'],'critical')
        self.assertEqual(alerts[0]['status'],'open')
        self.assertFalse(response['bank_verified'])

    def test_scan_repeated_deduplicates(self):
        self.policy()
        self.cause_cash_gap()
        first=self.scan()
        again=self.scan()
        self.assertEqual(first['created_count'],1)
        self.assertEqual(again['created_count'],0)
        self.assertEqual(len(again['deduplicated']),1)
        self.assertEqual(len(self.alerts()),1)

    def test_idempotency_replay_scan(self):
        self.policy()
        self.cause_cash_gap()
        k=key()
        first=self.scan(idem=k)
        second=self.scan(idem=k)
        self.assertEqual(first,second)
        self.assertEqual(len(self.alerts()),1)
        with self.assertRaises(Conflict):
            self.policy({},idem=k)

    def test_unscheduled_cost_warning(self):
        self.policy()
        self.expense(5000)
        created=self.scan()
        names={a['rule'] for a in self.alerts()}
        self.assertEqual(names,{'UNSCHEDULED_COSTS'})
        self.assertEqual(created['created_count'],1)

    def test_overdue_receipts_warning(self):
        self.policy()
        self.receipt(15000,self.now[0]-2000)
        self.scan()
        names={a['rule'] for a in self.alerts()}
        self.assertIn('OVERDUE_RECEIPTS',names)

    def test_budget_overrun_warning(self):
        self.policy()
        self.call('commerce.finance.budget.set',{
            'project_id':self.project,'expected_version':0,
            'budget_minor':100},write=True)
        self.expense(5000,kind='incurred')
        self.scan()
        self.assertEqual([a['rule'] for a in self.alerts()],['OVER_BUDGET_PROJECTS'])

    def test_positive_balance_floor_warning(self):
        self.policy({'min_balance_minor':10000,'starting_balance_minor':2000})
        self.scan()
        self.assertEqual([a['rule'] for a in self.alerts()],['BALANCE_FLOOR'])

    def test_custom_threshold_suppresses_warnings(self):
        self.policy({'max_unscheduled_outflow_minor':10000,
                     'max_overdue_inflow_minor':30000})
        self.expense(5000)
        self.receipt(12000,self.now[0]-1000)
        self.assertEqual(self.scan()['created_count'],0)

    def test_rule_changes_snapshot_without_duplicate_episode(self):
        self.policy()
        self.expense(5000)
        self.scan()
        alert=self.alerts()[0]
        self.expense(3000)
        changed=self.scan()
        self.assertEqual(changed['created_count'],0)
        self.assertEqual(len(changed['updated']),1)
        updated=self.alerts()[0]
        self.assertEqual(updated['episode'],1)
        self.assertEqual(updated['observed_value'],8000)
        self.assertEqual(updated['version'],2)
        self.assertEqual(len(self.alerts()),1)

    def test_acknowledge_requires_version(self):
        self.policy();self.expense(1000);self.scan()
        alert=self.alerts()[0]
        ack=self.call('commerce.alerts.ack',{
            'alert_id':alert['id'],'expected_version':1},write=True)
        self.assertEqual(ack['status'],'acknowledged')
        self.assertEqual(ack['version'],2)
        with self.assertRaises(Conflict):
            self.call('commerce.alerts.ack',{
                'alert_id':alert['id'],'expected_version':1},write=True)

    def test_dismiss_requires_reason_and_owner(self):
        self.policy();self.expense(1000);self.scan()
        alert=self.alerts()[0]
        with self.assertRaises(Unauthorized):
            self.call('commerce.alerts.dismiss',{
                'alert_id':alert['id'],'expected_version':1,
                'reason':'Owner waiver'},self.operator,True)
        with self.assertRaises(Invalid):
            self.call('commerce.alerts.dismiss',{
                'alert_id':alert['id'],'expected_version':1,
                'reason':''},write=True)
        done=self.call('commerce.alerts.dismiss',{
            'alert_id':alert['id'],'expected_version':1,
            'reason':'Accepted local risk'},write=True)
        self.assertEqual(done['status'],'dismissed')

    def test_dismissed_risk_does_not_reopen_until_clear(self):
        self.policy();e=self.expense(9000);self.scan()
        a=self.alerts()[0]
        self.call('commerce.alerts.dismiss',{
            'alert_id':a['id'],'expected_version':1,'reason':'Accepted'},write=True)
        self.scan()
        self.assertEqual(len(self.alerts()),1)
        self.assertEqual(self.alerts()[0]['status'],'dismissed')
        # Risk disappears after legitimate expense cancellation.
        self.call('commerce.finance.expenses.void',{
            'project_id':self.project,'expense_id':e['id'],
            'expected_version':1,'reason':'Cancelled'},write=True)
        self.assertEqual(len(self.scan()['cleared']),1)
        self.assertEqual(self.alerts()[0]['status'],'cleared')
        self.expense(5000);self.scan()
        alerts=self.alerts()
        self.assertEqual(len(alerts),2)
        self.assertEqual(sorted(a['episode'] for a in alerts),[1,2])

    def test_clear_closes_open_incident(self):
        self.policy();e=self.expense(9000);self.scan()
        self.call('commerce.finance.expenses.void',{
            'project_id':self.project,'expense_id':e['id'],
            'expected_version':1,'reason':'Not needed'},write=True)
        result=self.scan()
        self.assertEqual(len(result['cleared']),1)
        self.assertEqual(self.alerts()[0]['status'],'cleared')

    def test_alert_history_hash_verification(self):
        self.policy();self.expense();self.scan()
        a=self.alerts()[0]
        result=self.call('commerce.alerts.history',{'alert_id':a['id']})
        self.assertEqual(result['total'],1)
        self.assertEqual(result['events'][0]['action'],'detected')
        self.assertEqual(len(result['head']),64)

    def test_history_triggers_block_tampering(self):
        self.policy();self.expense();self.scan()
        with self.app.connect() as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE financial_alert_events SET actor='evil'")

    def test_history_digest_detects_admin_tampering(self):
        self.policy();self.expense();self.scan()
        a=self.alerts()[0]
        with self.app.connect() as db:
            db.execute('DROP TRIGGER financial_alert_events_no_update')
            db.execute('UPDATE financial_alert_events SET actor=? '
                       'WHERE alert_id=?',('evil',a['id']))
        with self.assertRaises(Conflict):
            self.call('commerce.alerts.history',{'alert_id':a['id']})

    def test_employee_task_created_atomically(self):
        self.policy();self.cause_cash_gap();self.scan()
        a=self.alerts()[0]
        delegated=self.call('commerce.alerts.task.create',{
            'alert_id':a['id'],'expected_version':1,'assignee':'engineer'},write=True)
        self.assertEqual(delegated['version'],2)
        self.assertEqual(delegated['assignee'],'engineer')
        self.assertFalse(delegated['external_notification_sent'])
        task=self.call('titan.work.get',{'id':delegated['work_id']},self.operator)['item']
        self.assertEqual(task['assignee'],'engineer')
        self.assertEqual(task['priority'],'critical')
        self.assertEqual(task['status'],'open')

    def test_operator_sees_only_assigned_alert_summary(self):
        self.policy();self.expense();self.scan()
        a=self.alerts()[0]
        self.assertEqual(self.call('commerce.alerts.mine',token=self.operator)['items'],[])
        self.call('commerce.alerts.task.create',{
            'alert_id':a['id'],'expected_version':1,'assignee':'engineer'},write=True)
        result=self.call('commerce.alerts.mine',token=self.operator)
        self.assertTrue(result['financial_values_redacted'])
        self.assertEqual(len(result['items']),1)
        self.assertNotIn('observed_value',result['items'][0])
        self.assertEqual(result['items'][0]['rule'],'UNSCHEDULED_COSTS')

    def test_wrong_employee_denied_without_task(self):
        self.policy();self.expense();self.scan()
        a=self.alerts()[0]
        with self.assertRaises(Invalid):
            self.call('commerce.alerts.task.create',{
                'alert_id':a['id'],'expected_version':1,
                'assignee':'nonexistent'},write=True)
        with self.app.connect() as db:
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM team_work WHERE tenant_id=?',
                (a['tenant_id'],)).fetchone()[0],0)

    def test_double_task_rejected(self):
        self.policy();self.expense();self.scan();a=self.alerts()[0]
        self.call('commerce.alerts.task.create',{
            'alert_id':a['id'],'expected_version':1,'assignee':'engineer'},write=True)
        with self.assertRaises(Conflict):
            self.call('commerce.alerts.task.create',{
                'alert_id':a['id'],'expected_version':2,'assignee':'engineer'},write=True)

    def test_concurrent_task_single_winner(self):
        self.policy();self.expense();self.scan();a=self.alerts()[0]
        def one(_):
            try:
                self.call('commerce.alerts.task.create',{
                    'alert_id':a['id'],'expected_version':1,'assignee':'engineer'},
                    write=True)
                return 'ok'
            except Conflict:
                return 'conflict'
        with ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(one,range(8)))
        self.assertEqual(results.count('ok'),1)
        self.assertEqual(results.count('conflict'),7)

    def test_cross_tenant_history_and_alert_lookup_denied(self):
        self.policy();self.expense();self.scan()
        a=self.alerts()[0]
        with self.assertRaises(Invalid):
            self.call('commerce.alerts.history',{'alert_id':a['id']},self.other)
        # A different owner cannot see same organization's data.
        self.assertEqual(self.call('commerce.alerts.list',token=self.other)['items'],[])

    def test_alert_list_status_and_limit(self):
        self.policy();self.expense();self.scan()
        self.assertEqual(len(self.call('commerce.alerts.list',{'status':'open','limit':1})['items']),1)
        self.assertEqual(self.call('commerce.alerts.list',{'status':'dismissed'})['items'],[])
        for bad in (0,201,True,1.1):
            with self.subTest(bad=bad),self.assertRaises(Invalid):
                self.call('commerce.alerts.list',{'limit':bad})

    def test_policy_change_updates_existing_incident_evidence(self):
        self.policy();self.expense(6000);self.scan()
        self.policy({'max_unscheduled_outflow_minor':2000},version=1)
        changed=self.scan(version=2)
        self.assertEqual(changed['created_count'],0)
        self.assertEqual(len(changed['updated']),1)
        self.assertEqual(self.alerts()[0]['episode'],1)

    def test_stale_policy_scan_rejected(self):
        self.policy();self.policy({'months':2},version=1)
        with self.assertRaises(Conflict):
            self.scan(version=1)

    def test_custom_project_scope_keeps_other_projects_out(self):
        self.policy({'project_state':'active'})
        self.expense(10000)
        self.assertEqual(self.scan()['created_count'],0)

    def test_idempotency_key_without_write_rejected(self):
        self.policy()
        with self.assertRaises(Invalid):
            self.app.execute(self.owner,'commerce.alerts.preview',{},key())
        with self.assertRaises(Invalid):
            self.app.execute(self.owner,'commerce.alerts.scan',
                {'expected_policy_version':1},None)

    def test_forecast_api_still_runs(self):
        self.assertEqual(self.call('commerce.cashflow.forecast')['project_count'],1)


if __name__=='__main__':
    unittest.main()
