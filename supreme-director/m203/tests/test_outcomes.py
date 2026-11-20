"""M203 before/after model evaluation, human review and anti-false-positive tests."""
from pathlib import Path
import tempfile
import unittest
import uuid

from osgard_m192.runtime import Conflict, Invalid, Unauthorized
from osgard_m203.runtime import Director203


def key():
    return "outcome-"+uuid.uuid4().hex


class OutcomeTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix="m203-outcome-")
        self.addCleanup(temp.cleanup)
        self.now=[1799971200]
        self.app=Director203(Path(temp.name)/"data.sqlite",
                             clock=lambda:self.now[0])
        self.app.initialize()
        self.owner=self.app.provision("Pilot Studio","boss")["token"]
        self.staff=self.app.issue_token(self.owner,"analyst","operator")["token"]
        self.other=self.app.provision("Different Tenant","outsider")["token"]
        client=self.call("commerce.customers.create",
            {"name":"Client","contact":"none"},write=True)["id"]
        deal=self.call("commerce.deals.create",{
            "customer_id":client,"title":"Deal",
            "amount_minor":900000,"stage":"new"},write=True)["id"]
        self.pid=self.call("commerce.projects.create",{
            "deal_id":deal,"title":"Delivery"},write=True)["id"]
        self.call("commerce.alerts.policy.set",{
            "expected_version":0,"config":{}},write=True)
        self.expense=self.call("commerce.finance.expenses.add",{
            "project_id":self.pid,"title":"Undated plan",
            "category":"services","amount_minor":9000,
            "kind":"planned"},write=True)
        self.first=self.call("commerce.monitor.scan",{
            "expected_policy_version":1},write=True)["snapshot"]
        self.alert=self.call("commerce.alerts.list")["items"][0]
        self.plan=self.call("commerce.actions.create",{
            "alert_id":self.alert["id"],
            "expected_alert_version":self.alert["version"],
            "baseline_snapshot_id":self.first["id"],"title":"Исправить даты",
            "hypothesis":"Введение планового срока уменьшит число недатированных расходов",
            "target_value":0,"due_at":self.now[0]+3600},write=True)
        self.step=self.call("commerce.actions.step.add",{
            "plan_id":self.plan["id"],"expected_version":1,
            "title":"Актуализировать сроки","description":"Проверить записи",
            "assignee":"analyst","due_at":self.now[0]+1800},write=True)

    def call(self,op,p=None,token=None,write=False):
        return self.app.execute(token or self.owner,op,p or {},
                                key() if write else None)

    def start(self):
        return self.call("commerce.actions.start",{
            "plan_id":self.plan["id"],"expected_version":2},write=True)

    def snapshot(self,changed=False):
        self.now[0]+=60
        if changed:
            self.call("commerce.finance.expenses.void",{
                "project_id":self.pid,"expense_id":self.expense["id"],
                "expected_version":1,"reason":"Plan corrected"},write=True)
        return self.call("commerce.monitor.scan",{
            "expected_policy_version":1},write=True)["snapshot"]

    def finish_task(self):
        return self.call("titan.work.status",{
            "id":self.step["work_id"],"expected_version":1,
            "status":"done"},self.staff,True)

    def evaluate(self,snapshot,version=3):
        return self.call("commerce.actions.evaluate",{
            "plan_id":self.plan["id"],"expected_version":version,
            "outcome_snapshot_id":snapshot["id"]},write=True)

    def review(self,evaluation,approved=True,reason="Проверено в модели"):
        return self.call("commerce.actions.review",{
            "plan_id":self.plan["id"],
            "expected_version":evaluation["plan_version"],
            "evaluation_id":evaluation["evaluation_id"],
            "approved":approved,"reason":reason},write=True)

    def test_evaluation_requires_active_plan(self):
        next_snapshot=self.snapshot()
        with self.assertRaises(Conflict):
            self.evaluate(next_snapshot,version=2)

    def test_cannot_evaluate_baseline_as_outcome(self):
        self.start()
        with self.assertRaises(Conflict):
            self.evaluate(self.first)

    def test_wrong_snapshot_id_rejected(self):
        self.start()
        with self.assertRaises(Invalid):
            self.evaluate({"id":"f"*32})

    def test_target_not_met_without_change(self):
        self.start()
        obs=self.snapshot()
        result=self.evaluate(obs)
        self.assertEqual(result["judgement"],"TARGET_NOT_REACHED")
        self.assertFalse(result["target_met"])
        self.assertEqual(result["improvement_value"],0)
        self.assertFalse(result["causation_proven"])

    def test_tasks_pending_block_model_acceptance(self):
        self.start()
        obs=self.snapshot(changed=True)
        e=self.evaluate(obs)
        self.assertTrue(e["target_met"])
        self.assertEqual(e["judgement"],"TASKS_NOT_FINISHED")
        with self.assertRaises(Conflict):
            self.review(e,approved=True)

    def test_finished_tasks_and_reduced_risk_eligible(self):
        self.start()
        self.finish_task()
        obs=self.snapshot(changed=True)
        result=self.evaluate(obs)
        self.assertTrue(result["target_met"])
        self.assertEqual(result["tasks_done"],1)
        self.assertEqual(result["tasks_total"],1)
        self.assertEqual(result["improvement_value"],9000)
        self.assertEqual(result["judgement"],
                         "MODEL_TARGET_REACHED_REVIEW_REQUIRED")
        self.assertFalse(result["bank_verified"])

    def test_explicit_owner_review_closes_model_plan(self):
        self.start()
        self.finish_task()
        obs=self.snapshot(changed=True)
        evaluated=self.evaluate(obs)
        reviewed=self.review(evaluated)
        self.assertEqual(reviewed["status"],"model_reviewed")
        self.assertEqual(reviewed["plan_version"],5)
        self.assertTrue(reviewed["human_reviewed_model_result"])
        self.assertFalse(reviewed["causation_proven"])
        self.assertFalse(reviewed["external_payment_executed"])
        report=self.call("commerce.actions.report")
        self.assertEqual(report["model_reviewed_count"],1)
        self.assertFalse(report["financial_outcome_proven"])

    def test_rejected_review_keeps_plan_active(self):
        self.start()
        obs=self.snapshot()
        evidence=self.evaluate(obs)
        result=self.review(evidence,approved=False,
                           reason="Метрика не снизилась")
        self.assertEqual(result["decision"],"RETURNED_FOR_WORK")
        self.assertEqual(result["status"],"active")
        item=self.call("commerce.actions.get",{
            "plan_id":self.plan["id"]})["item"]
        self.assertIsNone(item["latest_evaluation_id"])

    def test_invalid_review_flag_rejected(self):
        self.start()
        obs=self.snapshot()
        evidence=self.evaluate(obs)
        with self.assertRaises(Invalid):
            self.review(evidence,approved=1)

    def test_empty_review_reason_rejected(self):
        self.start()
        obs=self.snapshot()
        evidence=self.evaluate(obs)
        with self.assertRaises(Invalid):
            self.review(evidence,approved=False,reason="")

    def test_stale_plan_revision_prevents_review(self):
        self.start()
        obs=self.snapshot(changed=True)
        evidence=self.evaluate(obs)
        with self.assertRaises(Conflict):
            self.call("commerce.actions.review",{
                "plan_id":self.plan["id"],"expected_version":3,
                "evaluation_id":evidence["evaluation_id"],
                "approved":True,"reason":"Old version"},write=True)

    def test_new_snapshot_invalidates_old_review(self):
        self.start()
        self.finish_task()
        obs=self.snapshot(changed=True)
        evidence=self.evaluate(obs)
        self.snapshot()
        with self.assertRaises(Conflict):
            self.review(evidence)

    def test_double_evaluation_same_snapshot_rejected(self):
        self.start()
        obs=self.snapshot()
        self.evaluate(obs)
        with self.assertRaises(Conflict):
            self.evaluate(obs,version=4)

    def test_policy_version_change_invalidates_comparison(self):
        self.start()
        self.call("commerce.alerts.policy.set",{
            "expected_version":1,"config":{"months":3}},write=True)
        self.now[0]+=60
        obs=self.call("commerce.monitor.scan",{
            "expected_policy_version":2},write=True)["snapshot"]
        with self.assertRaises(Conflict):
            self.evaluate(obs)

    def test_review_requires_existing_evaluation(self):
        self.start()
        with self.assertRaises(Conflict):
            self.call("commerce.actions.review",{
                "plan_id":self.plan["id"],"expected_version":3,
                "evaluation_id":"e"*32,"approved":True,
                "reason":"No result"},write=True)

    def test_employee_cannot_financially_evaluate(self):
        self.start()
        obs=self.snapshot()
        with self.assertRaises(Unauthorized):
            self.call("commerce.actions.evaluate",{
                "plan_id":self.plan["id"],"expected_version":3,
                "outcome_snapshot_id":obs["id"]},self.staff,True)

    def test_action_results_are_not_persisted_as_payments(self):
        self.start()
        self.finish_task()
        obs=self.snapshot(changed=True)
        result=self.review(self.evaluate(obs))
        with self.app.connect() as db:
            lines=db.execute(
                "SELECT COUNT(*) FROM delivery_finance_receivables "
                "WHERE tenant_id=(SELECT tenant_id FROM financial_action_plans "
                "WHERE id=?)",(self.plan["id"],)
            ).fetchone()[0]
            self.assertEqual(lines,0)
        self.assertFalse(result["bank_verified"])

    def test_plan_event_chain_contains_review(self):
        self.start()
        self.finish_task()
        obs=self.snapshot(changed=True)
        self.review(self.evaluate(obs))
        history=self.call("commerce.actions.history",{
            "plan_id":self.plan["id"]})
        self.assertEqual(history["total"],5)
        self.assertEqual(history["items"][-1]["action"],"reviewed")


if __name__=="__main__":
    unittest.main()
