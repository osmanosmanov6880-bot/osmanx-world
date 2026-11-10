"""M204 real SQLite adversarial tests: ledger, ROI, priorities, RBAC, tampering."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

from osgard_m192.runtime import Invalid, Conflict, Unauthorized
from osgard_m203.runtime import Director203
from osgard_m204.runtime import Director204


def key():return "m204-"+uuid.uuid4().hex


class EconomicsTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix="osgard-m204-")
        self.addCleanup(temp.cleanup)
        self.path=Path(temp.name)/"test.sqlite"
        self.now=[1799971200]
        self.app=Director204(self.path,clock=lambda:self.now[0])
        self.app.initialize()
        self.owner=self.app.provision("Studio A","owner")["token"]
        self.staff=self.app.issue_token(self.owner,"employee","operator")["token"]
        self.viewer=self.app.issue_token(self.owner,"observer","viewer")["token"]
        self.foreign=self.app.provision("Studio B","foreign")["token"]
        client=self.call("commerce.customers.create",{
            "name":"Synthetic Client","contact":"local"},write=True)["id"]
        deal=self.call("commerce.deals.create",{
            "customer_id":client,"title":"Contract",
            "amount_minor":200000,"stage":"new"},write=True)["id"]
        self.project=self.call("commerce.projects.create",{
            "deal_id":deal,"title":"Construction"},write=True)["id"]
        self.call("commerce.alerts.policy.set",{
            "expected_version":0,"config":{}},write=True)
        self.expense=self.call("commerce.finance.expenses.add",{
            "project_id":self.project,"title":"Unscheduled plan",
            "kind":"planned","category":"services",
            "amount_minor":12000},write=True)
        self.initial=self.call("commerce.monitor.scan",{
            "expected_policy_version":1},write=True)["snapshot"]
        self.alert=self.call("commerce.alerts.list")["items"][0]
        self.plan=self.call("commerce.actions.create",{
            "alert_id":self.alert["id"],
            "expected_alert_version":self.alert["version"],
            "baseline_snapshot_id":self.initial["id"],
            "title":"Устранить недатированные расходы",
            "hypothesis":"Внести реальные даты плановых затрат и проверить неопределённость",
            "target_value":0,"due_at":self.now[0]+3600},write=True)
        self.plan_id=self.plan["id"]

    def call(self,op,p=None,token=None,write=False,idem=None):
        return self.app.execute(token or self.owner,op,p if p is not None else {},
            idem if idem is not None else key() if write else None)

    def add(self,kind,amount=10000,ref=None,note="Проверено вручную в исходной модели",
            plan_id=None,eval_id=None,idem=None):
        body={"plan_id":plan_id or self.plan_id,
              "kind":kind,"amount_minor":amount,
              "title":"Проверяемая запись",
              "evidence_note":note}
        if ref is not None:body["reference"]=ref
        if eval_id is not None:body["evaluation_id"]=eval_id
        return self.call("commerce.economics.entry.add",body,
                         write=True,idem=idem)

    def ledger(self,plan_id=None):
        return self.call("commerce.economics.ledger",{
            "plan_id":plan_id or self.plan_id})

    def void(self,entry,version=1,reason="Ошибка ручного ввода"):
        return self.call("commerce.economics.entry.void",{
            "entry_id":entry["id"],"expected_version":version,
            "reason":reason},write=True)

    def scenario(self,basis="planned",months=12,rates=None):
        return self.call("commerce.economics.scenarios",{
            "plan_id":self.plan_id,"cost_basis":basis,
            "horizon_months":months,
            "realization_rates_bp":rates if rates is not None else
                [5000,7500,10000]})

    def set_priority(self,version=0,urgency=4,impact=5,effort=2,
                     confidence=3,reason="Оценка по субъективной важности"):
        return self.call("commerce.economics.priority.set",{
            "plan_id":self.plan_id,"expected_version":version,
            "urgency":urgency,"impact":impact,"effort":effort,
            "confidence":confidence,"rationale":reason},write=True)

    def approve_model(self):
        task=self.call("commerce.actions.step.add",{
            "plan_id":self.plan_id,"expected_version":1,
            "title":"Выполнить действие",
            "description":"Проверить расходы","assignee":"employee",
            "due_at":self.now[0]+1500},write=True)
        self.call("commerce.actions.start",{
            "plan_id":self.plan_id,"expected_version":2},write=True)
        self.call("titan.work.status",{
            "id":task["work_id"],"expected_version":1,
            "status":"done"},token=self.staff,write=True)
        self.call("commerce.finance.expenses.void",{
            "project_id":self.project,"expense_id":self.expense["id"],
            "expected_version":1,"reason":"Удалён из плана"},write=True)
        self.now[0]+=120
        snapshot=self.call("commerce.monitor.scan",{
            "expected_policy_version":1},write=True)["snapshot"]
        evaluation=self.call("commerce.actions.evaluate",{
            "plan_id":self.plan_id,"expected_version":3,
            "outcome_snapshot_id":snapshot["id"]},write=True)
        self.call("commerce.actions.review",{
            "plan_id":self.plan_id,"expected_version":4,
            "evaluation_id":evaluation["evaluation_id"],"approved":True,
            "reason":"Модельный результат подтверждён, банковские данные отсутствуют"
        },write=True)
        return evaluation

    def test_migration_from_m203_without_loss(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"old.sqlite"
            original=Director203(p,clock=lambda:self.now[0])
            original.initialize()
            token=original.provision("Legacy Tenant","boss")["token"]
            current=Director204(p,clock=lambda:self.now[0])
            current.initialize()
            self.assertEqual(
                current.execute(token,"titan.session.get",{})["actor"],"boss")
            with current.connect() as con:
                names={x[0] for x in con.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'")}
                for table in ("economics_entries","economics_events","economics_priorities"):
                    self.assertIn(table,names)

    def test_empty_ledger_does_not_claim_cost_zero(self):
        data=self.ledger()
        self.assertEqual(data["total"],0)
        self.assertEqual(data["totals_minor"]["cost_planned"],0)
        result=self.scenario()
        self.assertEqual(result["projected_scenarios"][0]["status"],
                         "MISSING_SELECTED_COST_BASIS")
        self.assertIsNone(result["projected_scenarios"][0]["projected_roi_bp"])
        self.assertIsNone(result["self_reported_return"]["claimed_roi_bp"])

    def test_add_cost_planned_and_incurred_separately(self):
        self.add("cost_planned",100000)
        self.add("cost_incurred",60000)
        sums=self.ledger()["totals_minor"]
        self.assertEqual(sums["cost_planned"],100000)
        self.assertEqual(sums["cost_incurred"],60000)
        self.assertFalse(self.scenario()["bank_verified"])
        self.assertTrue(self.scenario()["cost_bases_not_combined"])

    def test_forecast_and_claim_are_separate_types(self):
        self.add("benefit_forecast_monthly",23000)
        sums=self.ledger()["totals_minor"]
        self.assertEqual(sums["benefit_forecast_monthly"],23000)
        self.assertEqual(sums["benefit_reported_once"],0)

    def test_invalid_kind_and_amount_rejected(self):
        for kind in ("cost","benefit","cost_actual","",None):
            with self.subTest(kind=kind),self.assertRaises(Invalid):
                self.add(kind)
        for amount in (True,False,0,-1,1.5,"500",10**14,None):
            with self.subTest(amount=amount),self.assertRaises(Invalid):
                self.add("cost_planned",amount)

    def test_evidence_note_required_for_manual_costs(self):
        for note in ("", "one", "test", "\tAttack"):
            with self.subTest(note=note),self.assertRaises(Invalid):
                self.add("cost_incurred",12000,note=note)

    def test_references_deduplicate_same_category(self):
        self.add("cost_incurred",12300,ref="expense-001")
        with self.assertRaises(Conflict):
            self.add("cost_incurred",12300,ref="expense-001")
        self.assertEqual(self.ledger()["total"],1)

    def test_reference_may_recur_in_other_kind(self):
        self.add("cost_planned",30000,ref="job-001")
        self.add("cost_incurred",28000,ref="job-001")
        self.assertEqual(self.ledger()["total"],2)

    def test_idempotent_cost_add_and_mismatch(self):
        idem=key()
        first=self.add("cost_planned",14000,idem=idem)
        again=self.add("cost_planned",14000,idem=idem)
        self.assertEqual(first,again)
        self.assertEqual(self.ledger()["total"],1)
        with self.assertRaises(Conflict):
            self.add("cost_planned",15000,idem=idem)

    def test_cost_void_requires_reason_and_version(self):
        item=self.add("cost_incurred",15000)
        with self.assertRaises(Invalid):
            self.void(item,reason="")
        with self.assertRaises(Conflict):
            self.void(item,version=2)
        result=self.void(item)
        self.assertEqual(result["state"],"voided")
        self.assertEqual(self.ledger()["totals_minor"]["cost_incurred"],0)
        with self.assertRaises(Conflict):
            self.void(item,version=2)

    def test_void_allows_reference_replacement(self):
        e=self.add("cost_incurred",14000,ref="local-invoice-001")
        self.void(e)
        again=self.add("cost_incurred",14000,ref="local-invoice-001")
        self.assertNotEqual(e["id"],again["id"])
        self.assertEqual(self.ledger()["totals_minor"]["cost_incurred"],14000)

    def test_ledger_event_history_replay(self):
        e=self.add("cost_planned",18000)
        self.set_priority()
        self.void(e)
        check=self.ledger()
        self.assertTrue(check["integrity"]["hash_verified"])
        self.assertEqual(check["integrity"]["events"],3)
        self.assertEqual(len(check["integrity"]["head"]),64)

    def test_events_have_immutable_sql_triggers(self):
        self.add("cost_incurred",20000)
        with self.app.connect() as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE economics_events SET actor='attacker'")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("DELETE FROM economics_events")

    def test_privileged_entry_tampering_detected(self):
        self.add("cost_incurred",20000)
        with self.app.connect() as db:
            db.execute("UPDATE economics_entries SET amount_minor=999999")
        with self.assertRaises(Conflict):
            self.ledger()

    def test_privileged_event_tampering_detected(self):
        self.add("cost_planned",5000)
        with self.app.connect() as db:
            db.execute("DROP TRIGGER immutable_economics_events_update")
            db.execute("UPDATE economics_events SET actor='attacker'")
        with self.assertRaises(Conflict):
            self.ledger()

    def test_reported_benefit_denied_without_model_review(self):
        with self.assertRaises(Conflict):
            self.add("benefit_reported_once",30000,
                     eval_id="a"*32,ref="benefit-2026-01")

    def test_forecast_cannot_forge_evaluation_reference(self):
        with self.assertRaises(Invalid):
            self.add("benefit_forecast_monthly",10000,
                     eval_id="b"*32)

    def test_self_reported_claim_requires_reviewed_snapshot(self):
        evaluation=self.approve_model()
        benefit=self.add("benefit_reported_once",50000,
            eval_id=evaluation["evaluation_id"],ref="claim-confirmation-001")
        self.assertEqual(benefit["kind"],"benefit_reported_once")
        self.assertEqual(self.ledger()["totals_minor"]["benefit_reported_once"],50000)
        with self.assertRaises(Conflict):
            self.add("benefit_reported_once",50000,
                eval_id=evaluation["evaluation_id"],ref="claim-confirmation-001")

    def test_self_reported_claim_requires_source_reference(self):
        evaluation=self.approve_model()
        with self.assertRaises(Invalid):
            self.add("benefit_reported_once",50000,
                     eval_id=evaluation["evaluation_id"])

    def test_self_reported_claim_contributes_only_reported_roi(self):
        evaluation=self.approve_model()
        self.add("cost_incurred",25000)
        self.add("benefit_reported_once",50000,
            eval_id=evaluation["evaluation_id"],ref="claim-statement-002")
        result=self.scenario("incurred")
        claim=result["self_reported_return"]
        self.assertEqual(claim["claimed_roi_bp"],10000)
        self.assertEqual(claim["status"],"UNVERIFIED_SELF_REPORTED_RETURN")
        self.assertIsNone(result["projected_scenarios"][0]["projected_roi_bp"])
        self.assertFalse(claim["bank_verified"])

    def test_scenario_projection_and_payback(self):
        self.add("cost_planned",100000)
        self.add("benefit_forecast_monthly",20000)
        result=self.scenario()
        values=result["projected_scenarios"]
        self.assertEqual([x["projected_roi_bp"] for x in values],
                         [2000,8000,14000])
        self.assertEqual([x["projected_payback_months"] for x in values],
                         [10,7,5])
        self.assertTrue(values[0]["payback_within_horizon"])
        self.assertFalse(result["financial_outcome_proven"])

    def test_explicit_zero_benefit_assumption_is_not_undefined(self):
        self.add("cost_planned",100000)
        self.add("benefit_forecast_monthly",20000)
        first=self.scenario(rates=[0,5000,10000])["projected_scenarios"][0]
        self.assertEqual(first["projected_roi_bp"],-10000)
        self.assertIsNone(first["projected_payback_months"])

    def test_forecast_cost_basis_not_interchangeable(self):
        self.add("cost_planned",100000)
        self.add("benefit_forecast_monthly",20000)
        projected=self.scenario("planned")["projected_scenarios"][0]
        incurred=self.scenario("incurred")["projected_scenarios"][0]
        self.assertIsNotNone(projected["projected_roi_bp"])
        self.assertIsNone(incurred["projected_roi_bp"])
        self.assertEqual(incurred["status"],"MISSING_SELECTED_COST_BASIS")

    def test_forecast_no_monthly_benefit_refuses_roi(self):
        self.add("cost_planned",100000)
        first=self.scenario()["projected_scenarios"][0]
        self.assertEqual(first["status"],"NO_MONTHLY_BENEFIT_FORECAST")
        self.assertIsNone(first["projected_roi_bp"])

    def test_rate_and_horizon_validation(self):
        for rates in ([0,0,5000],[6000,5000,10000],[0,10001,10000],
                      [False,5000,10000],[0.3,6000,10000],[0,10000]):
            with self.subTest(rates=rates),self.assertRaises(Invalid):
                self.scenario(rates=rates)
        for months in (0,37,True,2.5,"12"):
            with self.subTest(months=months),self.assertRaises(Invalid):
                self.scenario(months=months)

    def test_priority_requires_explicit_owner_ratings(self):
        result=self.set_priority()
        self.assertEqual(result["score_x100"],3000)
        self.assertEqual(result["score_basis"],"OWNER_SUBJECTIVE_INPUTS_ONLY")
        board=self.call("commerce.economics.priority.board")
        self.assertEqual(board["ranked_count"],1)
        self.assertEqual(board["items"][0]["rank"],1)
        self.assertTrue(board["assessments_subjective"])

    def test_priority_version_and_noop(self):
        self.set_priority()
        with self.assertRaises(Conflict):
            self.set_priority(version=0)
        with self.assertRaises(Conflict):
            self.set_priority(version=1)
        value=self.set_priority(version=1,effort=3)
        self.assertEqual(value["version"],2)

    def test_priority_invalid_ratings_and_rationale(self):
        for x in (0,6,True,False,"5",1.2):
            with self.subTest(v=x),self.assertRaises(Invalid):
                self.set_priority(impact=x)
        with self.assertRaises(Invalid):
            self.set_priority(reason="none")

    def test_priority_tampering_detected(self):
        self.set_priority()
        with self.app.connect() as db:
            db.execute("UPDATE economics_priorities SET urgency=1")
        with self.assertRaises(Conflict):
            self.call("commerce.economics.priority.board")

    def test_portfolio_separates_planned_and_actual(self):
        self.add("cost_planned",20000)
        self.add("cost_incurred",15000)
        self.add("benefit_forecast_monthly",6000)
        output=self.call("commerce.economics.portfolio")
        self.assertEqual(output["cost_planned_minor"],20000)
        self.assertEqual(output["cost_incurred_minor"],15000)
        self.assertEqual(output["forecast_monthly_minor"],6000)
        self.assertTrue(output["planned_and_incurred_not_combined"])
        self.assertFalse(output["bank_verified"])

    def test_export_csv_without_formula_execution(self):
        output=self.call("commerce.economics.portfolio.csv")
        self.assertTrue(output["content"].startswith("\ufeff"))
        self.assertEqual(output["rows"],1)
        self.assertTrue(output["formula_injection_guard"])

    def test_cross_tenant_permissions_and_no_leak(self):
        self.add("cost_planned",22000)
        for token in (self.staff,self.viewer):
            for op,payload in (
                ("commerce.economics.ledger",{"plan_id":self.plan_id}),
                ("commerce.economics.priority.board",{}),
                ("commerce.economics.portfolio",{})):
                with self.subTest(op=op),self.assertRaises(Unauthorized):
                    self.call(op,payload,token=token)
        foreign_board=self.call("commerce.economics.priority.board",
                                token=self.foreign)
        self.assertEqual(foreign_board["items"],[])
        with self.assertRaises(Invalid):
            self.call("commerce.economics.ledger",
                      {"plan_id":self.plan_id},token=self.foreign)

    def test_concurrent_same_reference_one_writer(self):
        def run(_):
            try:
                self.add("cost_incurred",4000,ref="invoice-123")
                return "created"
            except Conflict:
                return "conflict"
        with ThreadPoolExecutor(max_workers=6) as pool:
            out=list(pool.map(run,range(6)))
        self.assertEqual(out.count("created"),1)
        self.assertEqual(out.count("conflict"),5)

    def test_readonly_endpoints_do_not_write_request_log(self):
        self.add("cost_planned",50000)
        self.set_priority()
        with self.app.connect() as db:
            before=db.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
        self.ledger()
        self.scenario()
        self.call("commerce.economics.priority.board")
        self.call("commerce.economics.portfolio")
        self.call("commerce.economics.portfolio.csv")
        with self.app.connect() as db:
            after=db.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
        self.assertEqual(before,after)

    def test_existing_M203_workflow_still_readable(self):
        self.add("cost_planned",1000)
        result=self.call("commerce.actions.get",{"plan_id":self.plan_id})
        self.assertEqual(result["item"]["status"],"draft")


if __name__=="__main__":
    unittest.main()
