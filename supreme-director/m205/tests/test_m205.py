"""M205 real adversarial SQLite regression for reconciliation, recurring and ROI."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

from osgard_m192.runtime import Invalid, Conflict, Unauthorized
from osgard_m204.runtime import Director204
from osgard_m205.runtime import Director205


def key():
    return "m205-"+uuid.uuid4().hex


class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix="m205-regression-")
        self.addCleanup(temp.cleanup)
        self.path=Path(temp.name)/"test.sqlite"
        self.now=[1799971200]
        self.app=Director205(self.path,clock=lambda:self.now[0])
        self.app.initialize()
        self.owner=self.app.provision("Tenant A","owner")["token"]
        self.staff=self.app.issue_token(self.owner,"worker","operator")["token"]
        self.viewer=self.app.issue_token(self.owner,"viewer","viewer")["token"]
        self.foreign=self.app.provision("Tenant B","foreign")["token"]
        customer=self.call("commerce.customers.create",{
            "name":"Client","contact":"none"},write=True)["id"]
        deal=self.call("commerce.deals.create",{
            "customer_id":customer,"title":"Deal","stage":"new",
            "amount_minor":100000},write=True)["id"]
        self.project=self.call("commerce.projects.create",{
            "deal_id":deal,"title":"Main Project"},write=True)["id"]
        self.exp_planned=self.call("commerce.finance.expenses.add",{
            "project_id":self.project,"title":"Project supply",
            "category":"services","amount_minor":100000,
            "kind":"planned"},write=True)
        self.exp_incurred=self.call("commerce.finance.expenses.add",{
            "project_id":self.project,"title":"Recorded labor",
            "category":"labor","amount_minor":85000,
            "kind":"incurred"},write=True)
        self.call("commerce.alerts.policy.set",{
            "expected_version":0,"config":{}},write=True)
        baseline=self.call("commerce.monitor.scan",{
            "expected_policy_version":1},write=True)["snapshot"]
        self.alert=self.call("commerce.alerts.list")["items"][0]
        self.plan=self.call("commerce.actions.create",{
            "alert_id":self.alert["id"],
            "expected_alert_version":self.alert["version"],
            "baseline_snapshot_id":baseline["id"],
            "title":"=2+2 учебный план",
            "hypothesis":"Уточнение графика улучшит локальный прогноз",
            "target_value":0,
            "due_at":self.now[0]+3600},write=True)
        self.pid=self.plan["id"]

    def call(self,op,p=None,who=None,write=False,idem=None):
        return self.app.execute(who or self.owner,op,p if p is not None else {},
            idem if idem is not None else key() if write else None)

    def economic(self,kind="cost_planned",amount=100000,reference=None):
        return self.call("commerce.economics.entry.add",{
            "plan_id":self.pid,"kind":kind,"amount_minor":amount,
            "title":"Local money entry",
            "evidence_note":"Local cost estimate, not from verified bank records",
            "reference":reference or ("manual-"+key())
        },write=True)

    def link(self,e=None,source=None,expected_economic_version=1,
             expected_source_version=1,idem=None):
        e=e or self.economic()
        source=source or self.exp_planned
        return self.call("commerce.reconcile.link",{
            "plan_id":self.pid,"economic_entry_id":e["id"],
            "project_id":self.project,"expense_id":source["id"],
            "expected_economic_version":expected_economic_version,
            "expected_expense_version":expected_source_version
        },write=True,idem=idem)

    def recurring(self,basis="planned",amount=10000,
                  start=1,end=12,reference=None):
        return self.call("commerce.recurring.add",{
            "plan_id":self.pid,"basis":basis,
            "title":"Monthly service","amount_minor":amount,
            "start_month":start,"end_month":end,
            "evidence_note":"Owner manually entered monthly service estimate",
            "reference":reference or ("service-"+key())
        },write=True)

    def scenario(self,basis="planned",recurrent="planned",
                 require=False,zero=False,rates=None,months=12):
        return self.call("commerce.economics.net_scenarios",{
            "plan_id":self.pid,"cost_basis":basis,
            "recurring_basis":recurrent,"horizon_months":months,
            "realization_rates_bp":rates if rates is not None else
                [5000,7500,10000],
            "require_reconciled_costs":require,
            "assume_zero_recurring":zero
        })

    def inspect(self):
        return self.call("commerce.reconcile.inspect",{"plan_id":self.pid})

    def list_recurring(self):
        return self.call("commerce.recurring.list",{"plan_id":self.pid})

    def test_migration_m204_database_is_additive(self):
        with tempfile.TemporaryDirectory() as t:
            path=Path(t)/"legacy.sqlite"
            old=Director204(path,clock=lambda:self.now[0])
            old.initialize()
            token=old.provision("Legacy","boss")["token"]
            migrated=Director205(path,clock=lambda:self.now[0])
            migrated.initialize()
            self.assertEqual(
                migrated.execute(token,"titan.session.get",{})["actor"],"boss")
            with migrated.connect() as db:
                tables={r[0] for r in db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'")}
                self.assertIn("m205_events",tables)
                self.assertIn("m205_cost_links",tables)
                self.assertIn("m205_recurring_costs",tables)

    def test_no_auto_link_even_when_amount_matches(self):
        e=self.economic()
        report=self.inspect()
        self.assertEqual(report["basis"]["cost_planned"]["unlinked_count"],1)
        self.assertEqual(report["basis"]["cost_planned"]["linked_valid_count"],0)
        candidate=report["candidate_groups"][0]
        self.assertEqual(candidate["economic_entry_id"],e["id"])
        self.assertTrue(candidate["must_confirm_manually"])
        self.assertEqual(candidate["potential_matches"][0]["id"],
                         self.exp_planned["id"])

    def test_link_exact_cost_kind_amount_and_version(self):
        e=self.economic()
        result=self.link(e)
        self.assertEqual(result["state"],"active")
        self.assertFalse(result["bank_verified"])
        report=self.inspect()
        self.assertEqual(report["basis"]["cost_planned"]["linked_valid_count"],1)
        self.assertTrue(report["basis"]["cost_planned"]["complete"])
        self.assertEqual(report["basis"]["cost_planned"]["total_cost_minor"],100000)
        self.assertEqual(report["basis"]["cost_planned"]["linked_cost_minor"],100000)
        self.assertEqual(report["double_count_prevention"],
                         "USE_M204_ENTRY_ONCE; M198_IS_EVIDENCE_ONLY")

    def test_same_source_cannot_link_two_manual_costs(self):
        self.link()
        second=self.economic(reference="second-distinct-reference")
        with self.assertRaises(Conflict):
            self.link(second)
        self.assertEqual(self.inspect()["basis"]["cost_planned"]["linked_valid_count"],1)

    def test_manual_cost_cannot_link_twice(self):
        e=self.economic()
        self.link(e)
        with self.assertRaises(Conflict):
            self.link(e)

    def test_amount_mismatch_denied(self):
        e=self.economic(amount=99999)
        with self.assertRaises(Conflict):
            self.link(e)

    def test_kind_mismatch_denied(self):
        e=self.economic(kind="cost_incurred",amount=100000)
        with self.assertRaises(Conflict):
            self.link(e)

    def test_stale_expense_version_denied(self):
        e=self.economic()
        with self.assertRaises(Conflict):
            self.link(e,expected_source_version=100)

    def test_foreign_project_expense_denied(self):
        e=self.economic()
        with self.assertRaises(Invalid):
            self.call("commerce.reconcile.link",{
                "plan_id":self.pid,"economic_entry_id":e["id"],
                "project_id":"a"*32,"expense_id":self.exp_planned["id"],
                "expected_economic_version":1,
                "expected_expense_version":1
            },write=True)

    def test_reconciled_link_drifts_on_source_commit(self):
        e=self.economic()
        self.link(e)
        self.call("commerce.finance.expenses.commit",{
            "project_id":self.project,"expense_id":self.exp_planned["id"],
            "expected_version":1},write=True)
        report=self.inspect()
        self.assertEqual(report["basis"]["cost_planned"]["stale_link_count"],1)
        self.assertEqual(report["links"][0]["match_status"],"SOURCE_VERSION_CHANGED")
        self.assertEqual(self.scenario(require=True,zero=True)["scenarios"][0]["status"],
                         "SOURCE_LINK_DRIFT_REQUIRES_REVIEW")

    def test_reconciled_link_drifts_on_source_void(self):
        e=self.economic()
        self.link(e)
        self.call("commerce.finance.expenses.void",{
            "project_id":self.project,"expense_id":self.exp_planned["id"],
            "expected_version":1,"reason":"No longer planned"},write=True)
        self.assertEqual(self.inspect()["links"][0]["match_status"],"SOURCE_VOIDED")

    def test_source_unlink_requires_version_and_reason(self):
        e=self.economic()
        linked=self.link(e)
        with self.assertRaises(Conflict):
            self.call("commerce.reconcile.unlink",{
                "link_id":linked["link_id"],"expected_version":2,
                "reason":"Old version"},write=True)
        with self.assertRaises(Invalid):
            self.call("commerce.reconcile.unlink",{
                "link_id":linked["link_id"],"expected_version":1,
                "reason":""},write=True)
        value=self.call("commerce.reconcile.unlink",{
            "link_id":linked["link_id"],"expected_version":1,
            "reason":"Manual record source no longer matches"},write=True)
        self.assertEqual(value["state"],"unlinked")
        self.assertEqual(self.inspect()["basis"]["cost_planned"]["unlinked_count"],1)

    def test_economic_entry_void_marks_old_link_stale(self):
        e=self.economic()
        self.link(e)
        self.call("commerce.economics.entry.void",{
            "entry_id":e["id"],"expected_version":1,
            "reason":"Invalid manual input"},write=True)
        report=self.inspect()
        self.assertEqual(report["links"][0]["match_status"],"SOURCE_VOIDED")

    def test_cost_link_events_immutable(self):
        self.link()
        with self.app.connect() as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("DELETE FROM m205_events")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE m205_events SET actor='tamper'")

    def test_source_link_tampering_detected(self):
        self.link()
        with self.app.connect() as db:
            db.execute("UPDATE m205_cost_links SET amount_minor=999")
        with self.assertRaises(Conflict):
            self.inspect()

    def test_audit_event_tampering_detected(self):
        self.link()
        with self.app.connect() as db:
            db.execute("DROP TRIGGER immutable_m205_events_update")
            db.execute("UPDATE m205_events SET actor='tamper'")
        with self.assertRaises(Conflict):
            self.inspect()

    def test_link_idempotency_with_reused_key(self):
        e=self.economic()
        keyname=key()
        first=self.link(e,idem=keyname)
        second=self.link(e,idem=keyname)
        self.assertEqual(first,second)
        with self.assertRaises(Conflict):
            self.link(e,idem=keyname,expected_source_version=2)

    def test_concurrent_link_only_one_writer(self):
        e=self.economic()
        def attempt(_):
            try:
                self.link(e)
                return "created"
            except Conflict:
                return "conflict"
        with ThreadPoolExecutor(max_workers=6) as pool:
            result=list(pool.map(attempt,range(6)))
        self.assertEqual(result.count("created"),1)
        self.assertEqual(result.count("conflict"),5)

    def test_recurring_month_range_summed_per_month(self):
        r1=self.recurring(amount=3000,start=1,end=12)
        self.recurring(amount=2000,start=4,end=6)
        data=self.call("commerce.recurring.calendar",{
            "plan_id":self.pid,"basis":"planned","horizon_months":12})
        self.assertEqual(data["per_month_minor"][:3],[3000]*3)
        self.assertEqual(data["per_month_minor"][3:6],[5000]*3)
        self.assertEqual(data["per_month_minor"][6:],[3000]*6)
        self.assertEqual(data["total_minor"],42000)
        self.assertTrue(data["integrity"]["events"]>=2)

    def test_recurring_reported_and_planned_separate(self):
        self.recurring(basis="planned",amount=4000)
        self.recurring(basis="reported",amount=9000)
        p=self.call("commerce.recurring.calendar",{
            "plan_id":self.pid,"basis":"planned","horizon_months":12})
        a=self.call("commerce.recurring.calendar",{
            "plan_id":self.pid,"basis":"reported","horizon_months":12})
        self.assertEqual(p["total_minor"],48000)
        self.assertEqual(a["total_minor"],108000)
        self.assertFalse(a["bank_verified"])

    def test_recurring_duplicate_source_rejected(self):
        self.recurring(reference="monthly-saas-001")
        with self.assertRaises(Conflict):
            self.recurring(reference="monthly-saas-001")

    def test_recurring_malformed_months_and_types(self):
        for start,end in [(0,12),(2,1),(1,37),(True,12),
                          (1,"12"),(1,3.5)]:
            with self.subTest(v=(start,end)),self.assertRaises(Invalid):
                self.recurring(start=start,end=end)
        for value in (0,-1,True,2.5,"10",10**13):
            with self.subTest(v=value),self.assertRaises(Invalid):
                self.recurring(amount=value)

    def test_recurring_requires_real_source_note(self):
        with self.assertRaises(Invalid):
            self.call("commerce.recurring.add",{
                "plan_id":self.pid,"basis":"planned","title":"Support",
                "amount_minor":10000,"start_month":1,"end_month":12,
                "evidence_note":"short","reference":"vendor-1"
            },write=True)

    def test_recurring_void_removes_future_cost_not_history(self):
        added=self.recurring(amount=5000)
        voided=self.call("commerce.recurring.void",{
            "recurring_id":added["id"],"expected_version":1,
            "reason":"Contract cancelled"},write=True)
        self.assertEqual(voided["version"],2)
        data=self.call("commerce.recurring.calendar",{
            "plan_id":self.pid,"basis":"planned","horizon_months":12})
        self.assertEqual(data["active_records"],0)
        self.assertEqual(data["total_minor"],0)
        self.assertEqual(self.list_recurring()["total"],1)

    def test_recurring_stale_version_rejected(self):
        added=self.recurring()
        with self.assertRaises(Conflict):
            self.call("commerce.recurring.void",{
                "recurring_id":added["id"],"expected_version":2,
                "reason":"Cancelled"},write=True)

    def test_recurring_privileged_tampering_detected(self):
        self.recurring()
        with self.app.connect() as db:
            db.execute("UPDATE m205_recurring_costs SET amount_minor=1")
        with self.assertRaises(Conflict):
            self.list_recurring()

    def test_recurring_reported_cost_is_not_bank_verified(self):
        self.recurring(basis="reported")
        data=self.call("commerce.recurring.calendar",{
            "plan_id":self.pid,"basis":"reported","horizon_months":12})
        self.assertFalse(data["verified_external_bills"])

    def test_missing_recurring_requires_explicit_zero_assumption(self):
        self.economic(amount=100000)
        self.economic(kind="benefit_forecast_monthly",amount=25000)
        unknown=self.scenario()["scenarios"][0]
        self.assertEqual(unknown["status"],"MISSING_RECURRING_COST_ASSUMPTION")
        self.assertIsNone(unknown["projected_roi_bp"])
        known=self.scenario(zero=True)["scenarios"][0]
        self.assertEqual(known["status"],"PROJECTED_MANUAL_NET_ROI")
        self.assertFalse(known["bank_verified"])

    def test_zero_assumption_conflicts_with_entered_recurring(self):
        self.recurring()
        with self.assertRaises(Invalid):
            self.scenario(zero=True)

    def test_net_roi_accounts_for_recurring_costs_and_payback(self):
        self.economic(amount=100000)
        self.economic(kind="benefit_forecast_monthly",amount=25000)
        self.recurring(amount=5000)
        result=self.scenario()
        vals=result["scenarios"]
        self.assertEqual([r["projected_roi_bp"] for r in vals],
                         [-1000,6500,14000])
        self.assertEqual([r["payback_month"] for r in vals],
                         [None,8,5])
        self.assertEqual([r["sustained_payback_month"] for r in vals],
                         [None,8,5])
        self.assertEqual(vals[0]["months"][0]["projected_net_before_investment_minor"],7500)
        self.assertEqual(vals[0]["net_end_minor"],-10000)
        self.assertTrue(result["m198_expenses_not_added_a_second_time"])
        self.assertFalse(result["bank_verified"])

    def test_negative_monthly_net_never_claims_payback(self):
        self.economic(amount=100000)
        self.economic(kind="benefit_forecast_monthly",amount=25000)
        self.recurring(amount=30000)
        result=self.scenario()["scenarios"][2]
        self.assertLess(result["projected_roi_bp"],-10000)
        self.assertIsNone(result["payback_month"])

    def test_recurring_period_changes_monthly_break_even(self):
        self.economic(amount=100000)
        self.economic(kind="benefit_forecast_monthly",amount=30000)
        self.recurring(amount=60000,start=1,end=2)
        result=self.scenario()["scenarios"][2]
        self.assertLess(result["months"][0]["projected_net_before_investment_minor"],0)
        self.assertGreater(result["months"][2]["projected_net_before_investment_minor"],0)
        self.assertTrue(result["payback_month"]>4)

    def test_cost_basis_uses_exactly_one_m204_category(self):
        self.economic(amount=100000)
        self.economic(kind="cost_incurred",amount=85000)
        self.economic(kind="benefit_forecast_monthly",amount=25000)
        self.recurring(amount=5000)
        planned=self.scenario(basis="planned")
        incurred=self.scenario(basis="incurred")
        self.assertEqual(planned["one_off_cost_minor"],100000)
        self.assertEqual(incurred["one_off_cost_minor"],85000)
        self.assertNotEqual(planned["scenarios"][0]["projected_roi_bp"],
                            incurred["scenarios"][0]["projected_roi_bp"])

    def test_reconciled_mode_rejects_unlinked_costs(self):
        self.economic(amount=100000)
        self.economic(kind="benefit_forecast_monthly",amount=25000)
        self.recurring(amount=5000)
        blocked=self.scenario(require=True)["scenarios"][0]
        self.assertEqual(blocked["status"],"COST_RECONCILIATION_INCOMPLETE")
        self.assertIsNone(blocked["projected_roi_bp"])

    def test_reconciled_mode_succeeds_after_matching_link(self):
        e=self.economic(amount=100000)
        self.economic(kind="benefit_forecast_monthly",amount=25000)
        self.recurring(amount=5000)
        first=self.scenario(require=True)["scenarios"][0]
        self.assertIsNone(first["projected_roi_bp"])
        self.link(e)
        second=self.scenario(require=True)["scenarios"][0]
        self.assertIsNotNone(second["projected_roi_bp"])
        self.assertTrue(self.scenario(require=True)["source_cost_completely_reconciled"])

    def test_known_source_drift_blocks_roi_even_if_unrestricted(self):
        e=self.economic(amount=100000)
        self.economic(kind="benefit_forecast_monthly",amount=25000)
        self.recurring(amount=5000)
        self.link(e)
        self.call("commerce.finance.expenses.void",{
            "project_id":self.project,"expense_id":self.exp_planned["id"],
            "expected_version":1,"reason":"No longer valid"},write=True)
        current=self.scenario(require=False)["scenarios"][0]
        self.assertEqual(current["status"],"SOURCE_LINK_DRIFT_REQUIRES_REVIEW")
        self.assertIsNone(current["projected_roi_bp"])

    def test_strict_rates_horizon_and_boolean_validation(self):
        for rates in ([0,0,10000],[5000,4000,9000],
                      [0,10000],[True,5000,10000]):
            with self.subTest(r=rates),self.assertRaises(Invalid):
                self.scenario(rates=rates)
        for m in (0,37,True,"12"):
            with self.subTest(m=m),self.assertRaises(Invalid):
                self.scenario(months=m)
        with self.assertRaises(Invalid):
            self.call("commerce.economics.net_scenarios",{
                "plan_id":self.pid,"cost_basis":"planned",
                "recurring_basis":"planned","horizon_months":12,
                "realization_rates_bp":[5000,7500,10000],
                "require_reconciled_costs":"false",
                "assume_zero_recurring":False})

    def test_all_economics_pertain_to_correct_tenant(self):
        e=self.economic()
        self.recurring()
        for token in (self.staff,self.viewer):
            for op,request in (
                ("commerce.reconcile.inspect",{"plan_id":self.pid}),
                ("commerce.recurring.list",{"plan_id":self.pid}),
                ("commerce.economics.net_scenarios",{
                    "plan_id":self.pid,"cost_basis":"planned",
                    "recurring_basis":"planned","horizon_months":12,
                    "realization_rates_bp":[5000,7500,10000],
                    "require_reconciled_costs":False,
                    "assume_zero_recurring":False
                })
            ):
                with self.subTest(op=op),self.assertRaises(Unauthorized):
                    self.call(op,request,who=token)
        other=self.call("commerce.reconcile.portfolio",who=self.foreign)
        self.assertEqual(other["plans_total"],0)
        with self.assertRaises(Invalid):
            self.call("commerce.reconcile.inspect",{
                "plan_id":self.pid},who=self.foreign)

    def test_portfolio_does_not_double_source_expenses(self):
        e=self.economic(amount=100000)
        self.link(e)
        self.recurring(amount=5000)
        result=self.call("commerce.reconcile.portfolio")
        self.assertEqual(result["plans_total"],1)
        self.assertEqual(result["items"][0]["cost_planned_minor"],100000)
        self.assertEqual(result["totals"]["active_links"],1)
        self.assertEqual(result["totals"]["recurring_planned_total_12_minor"],60000)
        self.assertTrue(result["m198_expenses_never_added_to_m204_again"])

    def test_csv_protects_formula_like_plan_name(self):
        exported=self.call("commerce.reconcile.portfolio.csv")
        self.assertEqual(exported["rows"],1)
        self.assertIn("'=2+2 учебный план",exported["content"])
        self.assertTrue(exported["formula_injection_guard"])

    def test_readonly_does_not_create_idempotency_records(self):
        self.economic(amount=100000)
        self.recurring()
        with self.app.connect() as db:
            original=db.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
        self.inspect();self.list_recurring()
        self.scenario()
        self.call("commerce.reconcile.portfolio")
        self.call("commerce.reconcile.portfolio.csv")
        with self.app.connect() as db:
            current=db.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
        self.assertEqual(original,current)

    def test_roi_refuses_non_safe_json_financial_ratio(self):
        self.economic(kind="cost_planned",amount=1)
        self.economic(kind="benefit_forecast_monthly",amount=10**12)
        with self.assertRaises(Invalid):
            self.scenario(zero=True)

    def test_existing_m204_api_still_returns_report(self):
        self.economic(amount=100000)
        self.assertEqual(
            self.call("commerce.economics.ledger",{
                "plan_id":self.pid})["totals_minor"]["cost_planned"],100000)


if __name__=="__main__":
    unittest.main()
