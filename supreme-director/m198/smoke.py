"""Runnable offline M198 budget -> expenses -> receivable -> document proof scenario."""
import base64
from pathlib import Path
import json
import tempfile
from osgard_m198.runtime import Director198


def main():
    with tempfile.TemporaryDirectory() as tmp:
        app=Director198(Path(tmp)/'local.sqlite',clock=lambda:1_800_000_000)
        app.initialize();token=app.provision('Synthetic Studio','operator')['token']
        def action(op,data,write=False):
            # Unique keys for each independently created event.
            from uuid import uuid4
            return app.execute(token,op,data,('test-'+uuid4().hex) if write else None)
        client=action('commerce.customers.create',{'name':'Synthetic Client','contact':'local'},True)['id']
        deal=action('commerce.deals.create',{'customer_id':client,'title':'Synthetic service','amount_minor':1_200_000,'stage':'new'},True)['id']
        project=action('commerce.projects.create',{'deal_id':deal,'title':'Synthetic project'},True)['id']
        action('commerce.finance.budget.set',{'project_id':project,'expected_version':0,'budget_minor':700_000},True)
        expense=action('commerce.finance.expenses.add',{'project_id':project,'title':'Design','category':'labor','kind':'planned','amount_minor':150_000},True)
        action('commerce.finance.expenses.commit',{'project_id':project,'expense_id':expense['id'],'expected_version':1},True)
        planned=action('commerce.finance.expenses.add',{'project_id':project,'title':'Hosting','category':'software','kind':'planned','amount_minor':90_000},True)
        receivable=action('commerce.finance.receivables.add',{'project_id':project,'title':'Milestone invoice','amount_minor':400_000},True)
        version=action('commerce.projects.get',{'project_id':project})['project']['version']
        document=action('commerce.projects.documents.add',{'project_id':project,'expected_project_version':version,'name':'LocalConfirmation.txt','mime':'text/plain','base64':base64.b64encode(b'Example local customer acknowledgement').decode()},True)
        action('commerce.finance.receivables.resolve',{'project_id':project,'receivable_id':receivable['id'],'expected_version':1,'state':'recorded','evidence_document_id':document['id'],'evidence_sha256':document['sha256']},True)
        summary=action('commerce.finance.snapshot',{'project_id':project})['summary']
        assert summary['actual_cost_minor']==150000
        assert summary['planned_cost_minor']==90000
        assert summary['forecast_cost_minor']==240000
        assert summary['budget_minor']==700000
        assert summary['forecast_variance_minor']==-460000
        assert summary['manually_recorded_receivables_minor']==400000
        assert summary['real_payment_executed'] is False
        history=action('commerce.finance.history',{'project_id':project})
        assert len(history['events'])==6  # budget + two expense additions + incurred + receivable + recorded
        print(json.dumps({'result':'PASS','scenario':'LOCAL_ONLY','actual_minor':summary['actual_cost_minor'],
                          'planned_minor':summary['planned_cost_minor'],'forecast_minor':summary['forecast_cost_minor'],
                          'budget_minor':summary['budget_minor'],'payment_confirmed_by_bank':False},ensure_ascii=False))


if __name__=='__main__':main()
