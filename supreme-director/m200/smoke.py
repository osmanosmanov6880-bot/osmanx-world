"""Offline M200 end-to-end: schedule planned expense, then detect cash gap."""
from pathlib import Path
import json
import tempfile
import uuid
from osgard_m200.runtime import Director200

NOW=1799971200

def main():
    with tempfile.TemporaryDirectory() as folder:
        app=Director200(Path(folder)/'local.sqlite',clock=lambda:NOW)
        app.initialize()
        token=app.provision('Test Company','owner')['token']
        def call(op,p,write=False):
            return app.execute(token,op,p,'smoke-'+uuid.uuid4().hex if write else None)
        customer=call('commerce.customers.create',{'name':'Synthetic Client','contact':'none'},True)['id']
        deal=call('commerce.deals.create',{'customer_id':customer,'title':'Example Contract',
                                         'amount_minor':900000,'stage':'new'},True)['id']
        project=call('commerce.projects.create',{'deal_id':deal,'title':'Test Delivery'},True)['id']
        expense=call('commerce.finance.expenses.add',{'project_id':project,'title':'Work',
                'category':'services','amount_minor':40000,'kind':'planned'},True)
        call('commerce.finance.receivables.add',{'project_id':project,'title':'Expected invoice',
                'amount_minor':20000,'due_at':NOW+3600},True)
        first=call('commerce.cashflow.forecast',{'months':1})
        assert first['risk']=='INCOMPLETE_DATES'
        call('commerce.cashflow.schedule.set',{'project_id':project,'expense_id':expense['id'],
             'expected_expense_version':1,'expected_schedule_version':0,
             'due_at':NOW+3600},True)
        last=call('commerce.cashflow.forecast',{'months':1})
        assert last['risk']=='MODELED_GAP',last
        assert last['first_gap_month']=='2027-01'
        assert last['ending_balance_minor']==-20000
        assert not last['bank_verified']
        cases=call('commerce.cashflow.compare',{'months':1,'scenarios':[
            {'label':'Базовый'}, {'label':'Стресс','collection_rate_bp':5000}]})
        assert len(cases['scenarios'])==2
        print(json.dumps({'status':'M200_SMOKE_PASS','risk_before':first['risk'],
                          'risk_after':last['risk'],'first_gap':last['first_gap_month'],
                          'ending_balance_minor':last['ending_balance_minor'],
                          'bank_verified':False},ensure_ascii=False))

if __name__=='__main__':
    main()
