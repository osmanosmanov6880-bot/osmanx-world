"""M201 offline smoke: policy, incident, task delegation and risk clear."""
from pathlib import Path
import json
import tempfile
import uuid
from osgard_m201.runtime import Director201

NOW=1799971200

def main():
    with tempfile.TemporaryDirectory(prefix='m201-smoke-') as folder:
        app=Director201(Path(folder)/'synthetic.sqlite',clock=lambda:NOW)
        app.initialize()
        owner=app.provision('Synthetic Studio','boss')['token']
        worker=app.issue_token(owner,'engineer','operator')['token']
        def call(op,p=None,write=False,token=None):
            return app.execute(token or owner,op,p or {},
                'm201-smoke-'+uuid.uuid4().hex if write else None)
        customer=call('commerce.customers.create',
            {'name':'Sample Client','contact':'none'},True)['id']
        deal=call('commerce.deals.create',{
            'customer_id':customer,'title':'Sample Delivery',
            'amount_minor':100000,'stage':'new'},True)['id']
        project=call('commerce.projects.create',
            {'deal_id':deal,'title':'Sample Project'},True)['id']
        expense=call('commerce.finance.expenses.add',{
            'project_id':project,'title':'Undated deliverable',
            'category':'services','kind':'planned','amount_minor':15000},True)
        policy=call('commerce.alerts.policy.set',
            {'expected_version':0,'config':{}},True)
        preview=call('commerce.alerts.preview')
        assert any(i['rule']=='UNSCHEDULED_COSTS' and i['present']
                   for i in preview['rules'])
        scan=call('commerce.alerts.scan',
            {'expected_policy_version':policy['version']},True)
        assert scan['created_count']==1
        alert=call('commerce.alerts.list')['items'][0]
        assert alert['rule']=='UNSCHEDULED_COSTS'
        task=call('commerce.alerts.task.create',{
            'alert_id':alert['id'],'expected_version':alert['version'],
            'assignee':'engineer'},True)
        assigned=call('commerce.alerts.mine',token=worker)
        assert len(assigned['items'])==1
        assert 'observed_value' not in assigned['items'][0]
        work=call('titan.work.get',{'id':task['work_id']},token=worker)['item']
        assert work['priority']=='high'
        call('commerce.finance.expenses.void',{
            'project_id':project,'expense_id':expense['id'],
            'expected_version':1,'reason':'Cancelled planned cost'},True)
        cleared=call('commerce.alerts.scan',
            {'expected_policy_version':policy['version']},True)
        assert len(cleared['cleared'])==1
        assert call('commerce.alerts.list')['items'][0]['status']=='cleared'
        hist=call('commerce.alerts.history',{'alert_id':alert['id']})
        assert hist['total']==3
        print(json.dumps({
            'status':'M201_SMOKE_PASS','rule':alert['rule'],
            'linked_employee_task':True,'cleared_after_input_change':True,
            'event_chain_verified':True,'external_notifications':False,
            'bank_verified':False,'production_authorized':False
        },ensure_ascii=False))

if __name__=='__main__':
    main()
