"""M206 security and business tests: contradictions, source history, frozen backtests."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import sqlite3
import tempfile
import unittest
import uuid

from osgard_m192.runtime import Invalid, Conflict, Unauthorized
from osgard_m206.runtime import Director206
from osgard_m206.journal import digest

NOW=1799971200


def key():
    return "m206-test-"+uuid.uuid4().hex


class AssuranceTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory(prefix="m206-tests-")
        self.addCleanup(folder.cleanup)
        self.now=[NOW]
        self.app=Director206(Path(folder.name)/"db.sqlite",
                             clock=lambda:self.now[0])
        self.app.initialize()
        self.owner=self.app.provision("Assurance Tenant A","boss")["token"]
        self.staff=self.app.issue_token(self.owner,"employee","operator")["token"]
        self.viewer=self.app.issue_token(self.owner,"observer","viewer")["token"]
        self.foreign=self.app.provision("Assurance Tenant B","other")["token"]
        customer=self.call("commerce.customers.create",{
            "name":"Synthetic Client","contact":"local"},write=True)["id"]
        deal=self.call("commerce.deals.create",{
            "customer_id":customer,"title":"Contract","stage":"new",
            "amount_minor":200000},write=True)["id"]
        self.project=self.call("commerce.projects.create",{
            "deal_id":deal,"title":"Delivery"},write=True)["id"]
        self.expense=self.call("commerce.finance.expenses.add",{
            "project_id":self.project,"title":"Undated cost",
            "category":"services","kind":"planned",
            "amount_minor":100000},write=True)
        self.call("commerce.alerts.policy.set",{
            "expected_version":0,"config":{}},write=True)
        baseline=self.call("commerce.monitor.scan",{
            "expected_policy_version":1},write=True)["snapshot"]
        alert=self.call("commerce.alerts.list")["items"][0]
        self.plan=self.call("commerce.actions.create",{
            "alert_id":alert["id"],"expected_alert_version":alert["version"],
            "baseline_snapshot_id":baseline["id"],
            "title":"=2+2 diagnostic plan",
            "hypothesis":"Clarify undated costs in synthetic model",
            "target_value":0,"due_at":NOW+7200},write=True)
        self.pid=self.plan["id"]

    def call(self,op,p=None,who=None,write=False,idem=None):
        return self.app.execute(who or self.owner,
            op,p if p is not None else {},
            idem if idem is not None else key() if write else None)

    def entry(self,kind="cost_planned",amount=100000,ref=None):
        return self.call("commerce.economics.entry.add",{
            "plan_id":self.pid,"kind":kind,
            "amount_minor":amount,"title":"Local cost assumption",
            "evidence_note":"Entered from internal manual expense estimate",
            "reference":ref or key()
        },write=True)

    def source_link(self,record):
        return self.call("commerce.reconcile.link",{
            "plan_id":self.pid,
            "economic_entry_id":record["id"],
            "project_id":self.project,"expense_id":self.expense["id"],
            "expected_economic_version":1,
            "expected_expense_version":1,
        },write=True)

    def recurring(self,amount=5000,basis="planned",start=1,end=12):
        return self.call("commerce.recurring.add",{
            "plan_id":self.pid,"basis":basis,
            "title":"Ongoing service","amount_minor":amount,
            "start_month":start,"end_month":end,
            "evidence_note":"Owner manually estimated recurring operating costs",
            "reference":key()
        },write=True)

    def scan(self,idem=None):
        return self.call("commerce.assurance.scan",{
            "plan_id":self.pid},write=True,idem=idem)

    def latest(self,plan_id=None,who=None):
        return self.call("commerce.assurance.latest",{
            "plan_id":plan_id or self.pid},who=who)

    def ready(self,linked=True,recurring=True):
        cost=self.entry()
        self.entry("benefit_forecast_monthly",25000)
        if linked:self.source_link(cost)
        if recurring:self.recurring()
        return cost

    def freeze(self,linked=True,recurring=True,zero=False,
               rate_index=2,horizon=12,who=None,idem=None):
        return self.call("commerce.forecast.freeze",{
            "plan_id":self.pid,"cost_basis":"planned",
            "recurring_basis":"planned",
            "horizon_months":horizon,
            "realization_rates_bp":[5000,7500,10000],
            "scenario_index":rate_index,
            "require_reconciled_costs":linked,
            "assume_zero_recurring":zero,
            "rationale":"Baseline recorded before self-reported month results"
        },who=who,write=True,idem=idem)

    def observe(self,baseline,month=1,gross=22000,operating=5000,
                reference=None,idem=None):
        return self.call("commerce.forecast.observation.add",{
            "baseline_id":baseline,"month_index":month,
            "reported_gross_minor":gross,
            "reported_operating_minor":operating,
            "evidence_note":"Synthetic manual monthly report, no bank",
            "reference":reference or key(),
        },write=True,idem=idem)

    def test_latest_absent_not_reported_clean(self):
        latest=self.latest()
        self.assertFalse(latest["exists"])
        self.assertFalse(latest["bank_verified"])

    def test_diagnostics_detect_missing_inputs(self):
        report=self.scan()["snapshot"]
        codes={r["code"] for r in report["findings"]}
        for required in ("NO_ONE_TIME_COST_BASIS",
                         "NO_MONTHLY_BENEFIT_FORECAST",
                         "RECURRING_SOURCE_UNKNOWN"):
            self.assertIn(required,codes)
        self.assertTrue(report["complete_local_scan"])
        self.assertFalse(report["bank_verified"])

    def test_unmatched_cost_is_review_not_proven_duplicate(self):
        self.entry()
        findings=self.scan()["snapshot"]["findings"]
        warnings=[f for f in findings if f["code"]=="UNLINKED_MANUAL_COST"]
        self.assertEqual(len(warnings),1)
        self.assertEqual(warnings[0]["severity"],"review")

    def test_matching_link_clears_only_reconciliation_warning(self):
        e=self.entry()
        unlinked=self.scan()["snapshot"]["findings"]
        self.assertIn("UNLINKED_MANUAL_COST",{v["code"] for v in unlinked})
        self.source_link(e)
        linked=self.scan()["snapshot"]["findings"]
        self.assertNotIn("UNLINKED_MANUAL_COST",{v["code"] for v in linked})

    def test_ambiguous_local_match_remains_review_only(self):
        self.entry()
        self.call("commerce.finance.expenses.add",{
            "project_id":self.project,"title":"Another identical cost",
            "category":"services","kind":"planned","amount_minor":100000
        },write=True)
        reports=self.scan()["snapshot"]["findings"]
        self.assertIn("AMBIGUOUS_LOCAL_MATCH",{x["code"] for x in reports})
        row=next(v for v in reports if v["code"]=="AMBIGUOUS_LOCAL_MATCH")
        self.assertEqual(row["severity"],"review")

    def test_cross_basis_reference_is_not_proven_double_count(self):
        self.entry("cost_planned",100000,ref="same-source-01")
        self.entry("cost_incurred",70000,ref="same-source-01")
        report=self.scan()["snapshot"]
        self.assertIn("CROSS_BASIS_REFERENCE_REVIEW",
                      {x["code"] for x in report["findings"]})

    def test_stale_source_link_is_warning(self):
        e=self.entry()
        self.source_link(e)
        self.call("commerce.finance.expenses.commit",{
            "project_id":self.project,"expense_id":self.expense["id"],
            "expected_version":1},write=True)
        findings=self.scan()["snapshot"]["findings"]
        drift=[f for f in findings if f["code"]=="SOURCE_LINK_DRIFT"]
        self.assertEqual(len(drift),1)
        self.assertEqual(drift[0]["severity"],"warning")
        self.assertEqual(drift[0]["detail"]["match_status"],"SOURCE_VERSION_CHANGED")

    def test_two_scans_same_timestamp_keep_correct_hash_order(self):
        first=self.scan()
        second=self.scan()
        self.assertNotEqual(first["snapshot_head"],second["snapshot_head"])
        last=self.latest()
        self.assertEqual(last["scan_id"],second["scan_id"])
        hist=self.call("commerce.assurance.history",{"plan_id":self.pid})
        self.assertEqual(hist["total"],2)

    def test_scan_replay_idempotent(self):
        idem=key()
        first=self.scan(idem)
        second=self.scan(idem)
        self.assertEqual(first,second)
        self.assertEqual(self.call("commerce.assurance.history",{
            "plan_id":self.pid})["total"],1)
        with self.assertRaises(Conflict):
            self.call("commerce.forecast.freeze",{},write=True,idem=idem)

    def test_review_acknowledges_without_resolving(self):
        scan=self.scan()
        finding=scan["snapshot"]["findings"][0]
        result=self.call("commerce.assurance.acknowledge",{
            "plan_id":self.pid,"scan_id":scan["scan_id"],
            "finding_id":finding["id"],
            "reason":"Owner reviewed this issue and will inspect its source"
        },write=True)
        self.assertEqual(result["status"],"ACKNOWLEDGED_NOT_RESOLVED")
        last=self.latest()
        self.assertIn(finding["id"],last["acknowledged_finding_ids"])
        self.assertTrue(last["acknowledged_does_not_mean_resolved"])
        fresh=self.scan()
        self.assertIn(finding["id"],
                      {x["id"] for x in fresh["snapshot"]["findings"]})
        self.assertEqual(self.latest()["acknowledged_finding_ids"],[])

    def test_old_scan_cannot_be_acknowledged(self):
        old=self.scan()
        self.scan()
        finding=old["snapshot"]["findings"][0]
        with self.assertRaises(Conflict):
            self.call("commerce.assurance.acknowledge",{
                "plan_id":self.pid,"scan_id":old["scan_id"],
                "finding_id":finding["id"],"reason":"The old scan is superseded"
            },write=True)

    def test_unknown_finding_and_short_reason_denied(self):
        scan=self.scan()
        for fid,reason,expected in [
            ("a"*32,"The report is complete",Invalid),
            (scan["snapshot"]["findings"][0]["id"],"short",Invalid)
        ]:
            with self.subTest(fid=fid),self.assertRaises(expected):
                self.call("commerce.assurance.acknowledge",{
                    "plan_id":self.pid,"scan_id":scan["scan_id"],
                    "finding_id":fid,"reason":reason
                },write=True)

    def test_duplicate_review_denied(self):
        scan=self.scan()
        finding=scan["snapshot"]["findings"][0]
        body={"plan_id":self.pid,"scan_id":scan["scan_id"],
              "finding_id":finding["id"],
              "reason":"Owner manually examined the local record"}
        self.call("commerce.assurance.acknowledge",body,write=True)
        with self.assertRaises(Conflict):
            self.call("commerce.assurance.acknowledge",body,write=True)

    def test_scans_and_reviews_have_update_delete_triggers(self):
        scan=self.scan()
        f=scan["snapshot"]["findings"][0]
        self.call("commerce.assurance.acknowledge",{
            "plan_id":self.pid,"scan_id":scan["scan_id"],
            "finding_id":f["id"],
            "reason":"Manual financial review is planned"
        },write=True)
        with self.app.connect() as db:
            for table in ("m206_scans","m206_reviews","m206_events"):
                with self.subTest(table=table),self.assertRaises(sqlite3.IntegrityError):
                    db.execute("DELETE FROM "+table)
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute("UPDATE "+table+" SET actor='tampered'" if
                        table!="m206_scans" else
                        "UPDATE m206_scans SET created_by='tampered'")

    def test_privileged_scan_tampering_detected(self):
        self.scan()
        with self.app.connect() as db:
            db.execute("DROP TRIGGER immutable_m206_scans_update")
            db.execute("UPDATE m206_scans SET payload_hash='bad'")
        with self.assertRaises(Conflict):
            self.latest()

    def test_privileged_scan_event_tampering_detected(self):
        self.scan()
        with self.app.connect() as db:
            db.execute("DROP TRIGGER immutable_m206_events_update")
            db.execute("UPDATE m206_events SET actor='tampered'")
        with self.assertRaises(Conflict):
            self.latest()

    def test_portfolio_never_marks_missing_scans_as_clean(self):
        out=self.call("commerce.assurance.portfolio")
        self.assertEqual(out["plans_total"],1)
        self.assertEqual(out["items"][0]["scan_status"],"NOT_SCANNED")
        self.assertIsNone(out["items"][0]["warning_count"])
        self.assertTrue(out["not_scanned_is_not_clean"])

    def test_packet_hash_and_false_bank_attestation(self):
        self.scan()
        result=self.call("commerce.assurance.packet",{"plan_id":self.pid})
        self.assertEqual(result["sha256"],digest(result["packet"]))
        self.assertFalse(result["bank_verified"])
        self.assertFalse(result["packet"]["independent_audit"])

    def test_csv_formula_guard_for_plan_titles(self):
        csv=self.call("commerce.assurance.portfolio.csv")
        self.assertTrue(csv["content"].startswith("\ufeff"))
        self.assertIn("'=2+2 diagnostic plan",csv["content"])
        self.assertTrue(csv["formula_injection_guard"])

    def test_no_cost_inputs_cannot_freeze_forecast(self):
        with self.assertRaises(Conflict):
            self.freeze(linked=False,recurring=False,zero=True)

    def test_missing_recurring_requires_explicit_assumption(self):
        self.ready(linked=True,recurring=False)
        with self.assertRaises(Conflict):
            self.freeze(recurring=False,zero=False)
        result=self.freeze(recurring=False,zero=True)
        self.assertTrue(result["forecast_snapshot"]["assume_zero_recurring"])

    def test_unmatched_cost_blocked_when_reconciliation_required(self):
        self.ready(linked=False,recurring=True)
        with self.assertRaises(Conflict):
            self.freeze(linked=True)
        result=self.freeze(linked=False)
        self.assertFalse(result["forecast_snapshot"]["require_reconciled_costs"])

    def test_frozen_prediction_snapshots_source_heads(self):
        self.ready()
        frozen=self.freeze()
        payload=frozen["forecast_snapshot"]
        self.assertEqual(payload["horizon_months"],12)
        self.assertEqual(payload["scenario_rate_bp"],10000)
        self.assertEqual(payload["months"][0]["projected_net_before_investment_minor"],20000)
        self.assertEqual(len(payload["source_heads"]["m204_ledger"]),64)
        self.assertFalse(payload["bank_verified"])

    def test_frozen_baselines_are_immutable_sql(self):
        self.ready()
        self.freeze()
        with self.app.connect() as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE m206_forecasts SET payload_hash='bad'")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("DELETE FROM m206_forecasts")

    def test_two_forecasts_can_be_compared_separately(self):
        self.ready()
        first=self.freeze(rate_index=0)
        second=self.freeze(rate_index=2)
        self.assertNotEqual(first["payload_hash"],second["payload_hash"])
        listing=self.call("commerce.forecast.list",{"plan_id":self.pid})
        self.assertEqual(listing["total"],2)
        self.assertEqual(listing["items"][0]["active_observations"],0)

    def test_zero_observations_are_unknown_not_perfect(self):
        self.ready()
        baseline=self.freeze()["baseline_id"]
        report=self.call("commerce.forecast.backtest",{"baseline_id":baseline})
        self.assertIsNone(report["mean_absolute_error_minor"])
        self.assertIsNone(report["cumulative_signed_error_minor"])
        self.assertEqual(report["coverage_bp"],0)
        self.assertEqual(report["interpretation"],"NO_OBSERVATIONS")

    def test_monthly_report_error_is_signed_and_coverage_partial(self):
        self.ready()
        baseline=self.freeze()["baseline_id"]
        self.observe(baseline,month=1,gross=22000,operating=5000)
        result=self.call("commerce.forecast.backtest",{"baseline_id":baseline})
        self.assertEqual(result["mean_absolute_error_minor"],3000)
        self.assertEqual(result["mean_signed_error_minor"],-3000)
        self.assertEqual(result["coverage_bp"],833)
        self.assertEqual(result["missing_months"],11)
        self.assertEqual(result["months"][0]["reported_net_minor"],17000)
        self.assertFalse(result["independent_outcome_evidence"])

    def test_reported_zero_is_explicit_and_not_missing(self):
        self.ready()
        b=self.freeze()["baseline_id"]
        self.observe(b,gross=0,operating=0)
        result=self.call("commerce.forecast.backtest",{"baseline_id":b})
        self.assertEqual(result["observed_months"],1)
        self.assertEqual(result["months"][0]["reported_net_minor"],0)

    def test_duplicate_month_rejected(self):
        self.ready()
        b=self.freeze()["baseline_id"]
        self.observe(b,month=2)
        with self.assertRaises(Conflict):
            self.observe(b,month=2)

    def test_void_and_replace_observation_with_reason(self):
        self.ready()
        b=self.freeze()["baseline_id"]
        first=self.observe(b,gross=22000)
        self.call("commerce.forecast.observation.void",{
            "observation_id":first["observation_id"],
            "expected_version":1,"reason":"Corrected manually from revised source"
        },write=True)
        self.observe(b,gross=25000)
        outcome=self.call("commerce.forecast.backtest",{"baseline_id":b})
        self.assertEqual(outcome["mean_absolute_error_minor"],0)
        self.assertEqual(outcome["observed_months"],1)
        self.assertEqual(outcome["coverage_bp"],833)

    def test_stale_observation_version_rejected(self):
        self.ready()
        b=self.freeze()["baseline_id"]
        item=self.observe(b)
        with self.assertRaises(Conflict):
            self.call("commerce.forecast.observation.void",{
                "observation_id":item["observation_id"],
                "expected_version":2,
                "reason":"Wrong stale observation version"
            },write=True)

    def test_invalid_observation_amounts_months_and_notes(self):
        self.ready()
        b=self.freeze()["baseline_id"]
        for amount in (True,-1,10**13,"500",1.5):
            with self.subTest(amount=amount),self.assertRaises(Invalid):
                self.observe(b,gross=amount)
        for month in (0,13,True,"1"):
            with self.subTest(month=month),self.assertRaises(Invalid):
                self.observe(b,month=month)
        with self.assertRaises(Invalid):
            self.call("commerce.forecast.observation.add",{
                "baseline_id":b,"month_index":1,
                "reported_gross_minor":10,"reported_operating_minor":1,
                "evidence_note":"short","reference":"x"
            },write=True)

    def test_frozen_forecast_not_recalculated_after_source_change(self):
        self.ready()
        b=self.freeze()["baseline_id"]
        before=self.call("commerce.forecast.backtest",{"baseline_id":b})
        self.entry("cost_planned",1200,ref="later-addition")
        after=self.call("commerce.forecast.backtest",{"baseline_id":b})
        self.assertEqual(before["months"][0]["predicted_net_minor"],
                         after["months"][0]["predicted_net_minor"])
        self.assertIn("m204_ledger",after["sources_changed_since_freeze"])
        self.assertTrue(after["frozen_prediction_not_recomputed"])

    def test_forecast_snapshot_data_tampering_detected(self):
        self.ready()
        b=self.freeze()["baseline_id"]
        with self.app.connect() as db:
            db.execute("DROP TRIGGER immutable_m206_forecasts_update")
            db.execute("UPDATE m206_forecasts SET payload_hash='fake'")
        with self.assertRaises(Conflict):
            self.call("commerce.forecast.backtest",{"baseline_id":b})

    def test_monthly_observation_tampering_detected(self):
        self.ready()
        b=self.freeze()["baseline_id"]
        self.observe(b)
        with self.app.connect() as db:
            db.execute("UPDATE m206_observations SET reported_gross_minor=1")
        with self.assertRaises(Conflict):
            self.call("commerce.forecast.backtest",{"baseline_id":b})

    def test_owner_only_and_tenant_isolation(self):
        self.ready()
        b=self.freeze()["baseline_id"]
        self.scan()
        for who in (self.staff,self.viewer):
            for op,payload in (
                ("commerce.assurance.latest",{"plan_id":self.pid}),
                ("commerce.assurance.packet",{"plan_id":self.pid}),
                ("commerce.forecast.list",{"plan_id":self.pid}),
                ("commerce.forecast.backtest",{"baseline_id":b}),
            ):
                with self.subTest(who=who,op=op),self.assertRaises(Unauthorized):
                    self.call(op,payload,who=who)
        other=self.call("commerce.assurance.portfolio",who=self.foreign)
        self.assertEqual(other["plans_total"],0)
        with self.assertRaises(Invalid):
            self.call("commerce.assurance.latest",{
                "plan_id":self.pid},who=self.foreign)
        with self.assertRaises(Invalid):
            self.call("commerce.forecast.backtest",{
                "baseline_id":b},who=self.foreign)

    def test_write_idempotency_rejects_request_change(self):
        idem=key()
        first=self.scan(idem=idem)
        self.assertEqual(first,self.scan(idem=idem))
        with self.assertRaises(Conflict):
            self.call("commerce.assurance.acknowledge",{
                "plan_id":self.pid,"scan_id":first["scan_id"],
                "finding_id":first["snapshot"]["findings"][0]["id"],
                "reason":"Owner viewed this issue but not resolved"
            },write=True,idem=idem)

    def test_concurrent_same_month_only_one_wins(self):
        self.ready()
        b=self.freeze()["baseline_id"]
        def insert(_):
            try:
                self.observe(b,month=1)
                return "ok"
            except Conflict:
                return "collision"
        with ThreadPoolExecutor(max_workers=5) as pool:
            result=list(pool.map(insert,range(5)))
        self.assertEqual(result.count("ok"),1)
        self.assertEqual(result.count("collision"),4)

    def test_read_operations_do_not_create_idempotency_records(self):
        self.ready()
        b=self.freeze()["baseline_id"]
        self.scan()
        with self.app.connect() as db:
            before=db.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
        self.latest()
        self.call("commerce.assurance.history",{"plan_id":self.pid})
        self.call("commerce.assurance.packet",{"plan_id":self.pid})
        self.call("commerce.assurance.portfolio")
        self.call("commerce.assurance.portfolio.csv")
        self.call("commerce.forecast.list",{"plan_id":self.pid})
        self.call("commerce.forecast.backtest",{"baseline_id":b})
        with self.app.connect() as db:
            after=db.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
        self.assertEqual(before,after)

    def test_legacy_m205_api_still_works(self):
        result=self.call("commerce.reconcile.portfolio")
        self.assertEqual(result["plans_total"],1)
        self.assertFalse(result["bank_verified"])


if __name__=="__main__":
    unittest.main()
