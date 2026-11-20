"""M199 portfolio regression on real M192-M198 SQLite schemas, synthetic tenants."""
from __future__ import annotations

import csv
from io import StringIO
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest
import uuid

from osgard_m192.runtime import Invalid, Unauthorized
from osgard_m199.runtime import Director199, _month_list, _csv_cell


def key():
    return 'm199-' + uuid.uuid4().hex


class PortfolioTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix='m199-')
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.now = [1799971200]  # 2027-01-15 00:00:00 UTC
        self.app = Director199(self.root / 'director.sqlite', clock=lambda: self.now[0])
        self.app.initialize()
        self.owner = self.app.provision('Agency A', 'boss')['token']
        self.operator = self.app.issue_token(self.owner, 'sales', 'operator')['token']
        self.viewer = self.app.issue_token(self.owner, 'reader', 'viewer')['token']
        self.other = self.app.provision('Agency B', 'foreign')['token']
        self.first = self.create_project(self.owner, 'Project One')
        self.second = self.create_project(self.operator, 'Project Two')
        self.third = self.create_project(self.other, 'Project Other Tenant')

    def call(self, op, payload=None, token=None, *, write=False, idem=None):
        return self.app.execute(token or self.owner, op, payload or {}, idem if idem is not None else key() if write else None)

    def create_project(self, token, title):
        c = self.call('commerce.customers.create', {'name': title + ' Client', 'contact': 'none'}, token, write=True)['id']
        d = self.call('commerce.deals.create', {'customer_id': c, 'title': title,
                     'amount_minor': 1000000, 'stage': 'new'}, token, write=True)['id']
        return self.call('commerce.projects.create', {'deal_id': d, 'title': title}, token, write=True)['id']

    def budget(self, pid, minor, token=None):
        return self.call('commerce.finance.budget.set', {'project_id': pid, 'budget_minor': minor,
                                                         'expected_version': 0}, token, write=True)

    def expense(self, pid, minor, kind='planned', token=None):
        return self.call('commerce.finance.expenses.add', {'project_id': pid, 'amount_minor': minor,
                         'category': 'services', 'title': 'Expense', 'kind': kind}, token, write=True)

    def due(self, pid, minor, due=None, token=None):
        data = {'project_id': pid, 'title': 'Expected invoice', 'amount_minor': minor}
        if due is not None:
            data['due_at'] = due
        return self.call('commerce.finance.receivables.add', data, token, write=True)

    def overview(self, token=None, payload=None):
        return self.call('commerce.portfolio.overview', payload, token)

    def calendar(self, token=None, payload=None):
        return self.call('commerce.portfolio.calendar', payload, token)

    def test_owner_sees_only_tenant_projects(self):
        r = self.overview()
        self.assertEqual(r['totals']['project_count'], 2)
        self.assertEqual({x['project_id'] for x in r['projects']}, {self.first, self.second})
        self.assertFalse(r['external_bank_verified'])
        self.assertFalse(r['production_authorized'])
        self.assertEqual(r['original_task_acceptance'], 0)

    def test_operator_only_created_projects(self):
        r = self.overview(self.operator)
        self.assertEqual(r['totals']['project_count'], 1)
        self.assertEqual(r['projects'][0]['project_id'], self.second)
        self.assertEqual(r['scope'], 'OWN_CREATED_PROJECTS')

    def test_foreign_owner_sees_only_foreign(self):
        self.assertEqual([p['project_id'] for p in self.overview(self.other)['projects']], [self.third])

    def test_viewer_denied_every_endpoint(self):
        for op in ('commerce.portfolio.overview', 'commerce.portfolio.calendar', 'commerce.portfolio.export'):
            with self.subTest(op=op), self.assertRaises(Unauthorized):
                self.call(op, {}, self.viewer)

    def test_operator_finance_unchanged(self):
        self.budget(self.first, 3000)
        with self.assertRaises(Unauthorized):
            self.call('commerce.finance.snapshot', {'project_id': self.first}, self.operator)

    def test_budget_coverage_unknown_not_zero(self):
        result = self.overview()
        self.assertEqual(result['totals']['projects_without_budget'], 2)
        self.assertEqual(result['totals']['projects_with_budget'], 0)
        self.assertEqual(result['totals']['budget_coverage_percent'], 0)
        self.budget(self.first, 30000)
        result = self.overview()['totals']
        self.assertEqual(result['projects_without_budget'], 1)
        self.assertEqual(result['budget_minor'], 30000)
        self.assertEqual(result['budget_coverage_percent'], 50)

    def test_financial_rollup_cents(self):
        self.budget(self.first, 200000)
        self.budget(self.second, 300000, self.operator)
        self.expense(self.first, 20000, 'incurred')
        self.expense(self.second, 11000, 'planned', self.operator)
        self.due(self.first, 100000, self.now[0] + 700000)
        self.due(self.second, 30000, self.now[0] + 100, self.operator)
        totals = self.overview()['totals']
        self.assertEqual(totals['budget_minor'], 500000)
        self.assertEqual(totals['forecast_cost_minor'], 31000)
        self.assertEqual(totals['actual_cost_minor'], 20000)
        self.assertEqual(totals['planned_cost_minor'], 11000)
        self.assertEqual(totals['expected_receivables_minor'], 130000)
        self.assertEqual(totals['pending_receivables_minor'], 130000)
        self.assertEqual(totals['estimated_margin_minor'], 99000)
        self.assertEqual(totals['forecast_net_receivables_less_cost_minor'], 99000)

    def test_overdue_and_over_budget_risk(self):
        self.budget(self.first, 100)
        self.expense(self.first, 300, 'planned')
        self.due(self.first, 2000, self.now[0] - 86400)
        r = self.overview()
        self.assertEqual(r['totals']['overdue_receivables_count'], 1)
        self.assertEqual(r['totals']['over_budget_projects'], 1)
        self.assertEqual(r['risk_counts']['OVER_BUDGET'], 1)

    def test_project_state_filter(self):
        r = self.overview(payload={'project_state': 'active'})
        self.assertEqual(r['totals']['project_count'], 0)
        r = self.overview(payload={'project_state': 'planned'})
        self.assertEqual(r['totals']['project_count'], 2)

    def test_empty_scope_returns_no_arbitrary_money(self):
        r = self.overview(self.other, {'project_state': 'completed'})
        self.assertEqual(r['projects'], [])
        self.assertEqual(r['totals']['project_count'], 0)
        self.assertIsNone(r['totals']['budget_coverage_percent'])

    def test_asof_controls_overdue_classification(self):
        self.due(self.first, 5000, self.now[0] + 86400)
        self.assertEqual(self.overview()['totals']['overdue_receivables_count'], 0)
        self.assertEqual(self.overview(payload={'as_of': self.now[0] + 100000})['totals']['overdue_receivables_count'], 1)

    def test_readonly_snapshot_does_not_mutate_sqlite(self):
        with self.app.connect() as c:
            before = (c.execute('SELECT COUNT(*) FROM requests').fetchone()[0], c.execute('SELECT COUNT(*) FROM audit').fetchone()[0])
        self.overview(); self.calendar();self.call('commerce.portfolio.export')
        with self.app.connect() as c:
            after = (c.execute('SELECT COUNT(*) FROM requests').fetchone()[0], c.execute('SELECT COUNT(*) FROM audit').fetchone()[0])
        self.assertEqual(before, after)

    def test_invalid_types_fail_closed(self):
        bad = [None, '2027-01', 0, True, 12.4, {}, [], 4102444800]
        for sample in bad:
            with self.subTest(sample=sample), self.assertRaises(Invalid):
                self.overview(payload={'as_of': sample})

    def test_invalid_project_filter(self):
        for sample in ('invalid', 5, [], True):
            with self.subTest(value=sample), self.assertRaises(Invalid):
                self.overview(payload={'project_state': sample})

    def test_unknown_payload_keys_rejected(self):
        with self.assertRaises(Invalid):
            self.overview(payload={'project_id': self.first})
        with self.assertRaises(Invalid):
            self.calendar(payload={'foo': True})

    def test_readonly_rejects_idempotency_key(self):
        with self.assertRaises(Invalid):
            self.app.execute(self.owner, 'commerce.portfolio.overview', {}, key())

    def test_invalid_horizon(self):
        for sample in (0, 19, -1, False, 3.14, '6'):
            with self.subTest(sample=sample), self.assertRaises(Invalid):
                self.calendar(payload={'months': sample})

    def test_months_cross_year(self):
        self.assertEqual(_month_list(1799971200, 3), ['2027-01', '2027-02', '2027-03'])
        self.assertEqual(len(self.calendar(payload={'months': 18})['buckets']), 18)

    def test_cash_calendar_month_pending_reconciles(self):
        asof = self.now[0]
        self.due(self.first, 70000, asof + 3600)
        self.due(self.first, 1000, asof - 1000)
        self.due(self.first, 2000, None)
        self.due(self.first, 3000, asof + 400 * 86400)
        r = self.calendar(payload={'months': 3})
        self.assertEqual(r['totals']['pending_minor'], 76000)
        self.assertEqual(r['buckets'][0]['pending_due_minor'], 70000)
        self.assertEqual(r['outside_horizon']['overdue_pending_minor'], 1000)
        self.assertEqual(r['outside_horizon']['undated_pending_minor'], 2000)
        self.assertEqual(r['outside_horizon']['beyond_horizon_pending_minor'], 3000)
        self.assertEqual(r['outside_horizon']['overdue_pending_count'], 1)

    def test_incurred_not_double_counted_as_planned(self):
        self.expense(self.first, 10000, 'incurred')
        self.expense(self.first, 5000, 'planned')
        r = self.calendar()
        self.assertEqual(r['totals']['incurred_minor'], 10000)
        self.assertEqual(r['totals']['planned_expense_without_due_date_minor'], 5000)
        self.assertEqual(r['buckets'][0]['incurred_cost_minor'], 10000)
        self.assertEqual(r['buckets'][0]['pending_due_minor'], 0)

    def test_manual_recorded_receipts_separate(self):
        import base64, hashlib
        due = self.due(self.first, 20000, self.now[0] + 7200)
        data = b'Manual synthetic evidence'
        view = self.call('commerce.projects.get', {'project_id': self.first})
        proof = self.call('commerce.projects.documents.add', {
            'project_id': self.first, 'expected_project_version': view['project']['version'],
            'name': 'proof.txt', 'mime': 'text/plain', 'base64': base64.b64encode(data).decode()
        }, write=True)
        # Current-version file content is verified by M198.
        outcome = self.call('commerce.finance.receivables.resolve', {
            'project_id': self.first, 'receivable_id': due['id'], 'expected_version': 1,
            'state': 'recorded', 'evidence_document_id': proof['id'],
            'evidence_sha256': hashlib.sha256(data).hexdigest()
        }, write=True)
        self.assertFalse(outcome['external_bank_verified'])
        r = self.calendar()
        self.assertEqual(r['totals']['pending_minor'], 0)
        self.assertEqual(r['totals']['manual_recorded_minor'], 20000)
        self.assertEqual(r['buckets'][0]['manual_recorded_minor'], 20000)
        self.assertFalse(r['forecast_is_bank_cash_flow'])

    def test_calendar_only_operator_visible(self):
        self.due(self.first, 5000, self.now[0] + 700)
        self.due(self.second, 4000, self.now[0] + 700, self.operator)
        self.assertEqual(self.calendar(self.operator)['totals']['pending_minor'], 4000)
        self.assertEqual(self.calendar(self.other)['totals'].get('pending_minor', 0), 0)

    def test_calendar_no_partial_forecast(self):
        self.expense(self.first, 5000, 'planned')
        r = self.calendar()
        self.assertFalse(r['forecast_is_bank_cash_flow'])
        self.assertEqual(r['totals']['planned_expense_without_due_date_minor'], 5000)

    def test_cancellation_excluded(self):
        rec = self.due(self.first, 9000)
        self.call('commerce.finance.receivables.resolve', {
            'project_id': self.first, 'receivable_id': rec['id'],
            'expected_version': 1, 'state': 'cancelled', 'reason': 'Cancelled'
        }, write=True)
        self.assertEqual(self.calendar()['totals'].get('pending_minor', 0), 0)

    def test_export_headers_no_bom_or_injection(self):
        c = self.call('commerce.customers.create', {'name': '=CMD()', 'contact': 'test'}, write=True)['id']
        d = self.call('commerce.deals.create', {'customer_id': c, 'title': '@TEST', 'amount_minor': 1, 'stage': 'new'}, write=True)['id']
        self.call('commerce.projects.create', {'deal_id': d, 'title': '+danger'}, write=True)
        r = self.call('commerce.portfolio.export')
        rows = list(csv.reader(StringIO(r['csv_text'])))
        self.assertEqual(len(rows), 4)
        self.assertTrue(any(s[1] == "'+danger" and s[2] == "'=CMD()" for s in rows[1:]))
        self.assertEqual(r['row_count'], 3)
        self.assertFalse(r['production_authorized'])

    def test_csv_formula_spaces(self):
        self.assertTrue(_csv_cell('   =SUM(A1)').startswith("'"))
        self.assertTrue(_csv_cell('\t=1').startswith("'"))
        self.assertEqual(_csv_cell('ordinary title'), 'ordinary title')

    def test_parallel_read_requests_consistent(self):
        self.budget(self.first, 10000)
        with ThreadPoolExecutor(max_workers=8) as p:
            out = list(p.map(lambda _: self.overview()['totals']['budget_minor'], range(20)))
        self.assertEqual(out, [10000] * 20)

    def test_repeated_overview_deterministic(self):
        self.due(self.first, 150, self.now[0] + 100)
        self.assertEqual(self.overview(), self.overview())

    def test_more_than_1000_projects_refuses_partial_totals(self):
        with self.app.connect(transaction=True) as db:
            tenant = self.app._identity(db, self.owner)['tenant_id']
            original = db.execute('SELECT customer_id,deal_id FROM delivery_projects WHERE id=?',
                                  (self.first,)).fetchone()
            now = self.now[0]
            rows = [(uuid.uuid4().hex, tenant, original['customer_id'], original['deal_id'],
                     'Extra project', '', 'boss', 'planned', 1, now, now, None)
                    for _ in range(999)]
            db.executemany('INSERT INTO delivery_projects VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', rows)
        with self.assertRaisesRegex(Invalid, 'refusing partial'):
            self.overview()
        with self.assertRaisesRegex(Invalid, 'refusing partial'):
            self.calendar()

    def test_large_money_limit(self):
        self.budget(self.first, 10**12)
        self.budget(self.second, 10**12, self.operator)
        self.assertEqual(self.overview()['totals']['budget_minor'], 2*10**12)

    def test_origin_data_unchanged_by_portfolio(self):
        self.expense(self.first, 1000)
        before = self.call('commerce.finance.snapshot', {'project_id': self.first})['summary']
        self.overview();self.calendar()
        after = self.call('commerce.finance.snapshot', {'project_id': self.first})['summary']
        self.assertEqual(before, after)


if __name__ == '__main__':
    unittest.main()
