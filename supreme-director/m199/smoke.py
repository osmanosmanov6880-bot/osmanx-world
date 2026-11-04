"""M199 deterministic real local full-stack flow, never reaches external systems."""
from pathlib import Path
import json
import tempfile
import uuid
from osgard_m199.runtime import Director199


def main():
    with tempfile.TemporaryDirectory(prefix='osgard-m199-smoke-') as name:
        app = Director199(Path(name) / 'local.sqlite', clock=lambda: 1799971200)
        app.initialize()
        owner = app.provision('Synthetic only', 'owner')['token']
        def call(op, args):
            return app.execute(owner, op, args, 'smoke-' + uuid.uuid4().hex)
        c = call('commerce.customers.create', {'name':'Customer A','contact':'local'})['id']
        d = call('commerce.deals.create', {'customer_id':c,'title':'CRM','stage':'new','amount_minor':100000})['id']
        p = call('commerce.projects.create', {'deal_id':d,'title':'Synthetic CRM'})['id']
        call('commerce.finance.budget.set', {'project_id':p,'expected_version':0,'budget_minor':90000})
        call('commerce.finance.expenses.add', {'project_id':p,'title':'Work','category':'labor','kind':'planned','amount_minor':30000})
        call('commerce.finance.receivables.add', {'project_id':p,'title':'Initial invoice','amount_minor':65000,'due_at':1800057600})
        overview = app.execute(owner, 'commerce.portfolio.overview', {})
        calendar = app.execute(owner, 'commerce.portfolio.calendar', {'months':3})
        export = app.execute(owner, 'commerce.portfolio.export', {})
        assert overview['totals']['project_count']==1
        assert overview['totals']['budget_minor']==90000
        assert overview['totals']['forecast_cost_minor']==30000
        assert calendar['totals']['pending_minor']==65000
        assert export['row_count']==1 and export['csv_text'].count('Synthetic CRM')==1
        assert not overview['production_authorized']
        print(json.dumps({'status':'M199_LOCAL_SMOKE_PASS','projects':1,
                          'budget_minor':90000,'pending_minor':65000,
                          'bank_verification':False,'production_authorized':False},
                         ensure_ascii=False))


if __name__ == '__main__':
    main()
