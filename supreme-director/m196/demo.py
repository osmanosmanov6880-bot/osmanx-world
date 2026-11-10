"""Run an end-to-end synthetic M196 workflow without persistent secrets or network."""
from pathlib import Path
import json
import tempfile
from osgard_m196.runtime import Director196

def main():
    with tempfile.TemporaryDirectory() as d:
        runtime=Director196(Path(d)/'demo.sqlite')
        runtime.initialize()
        token=runtime.provision('Demo Tenant','owner')['token']
        def run(op,p,write=False):
            from uuid import uuid4
            return runtime.execute(token,op,p,'m196-'+uuid4().hex if write else None)
        customer=run('commerce.customers.create',{'name':'Тестовая компания','contact':'demo@example.invalid'},True)
        deal=run('commerce.deals.create',{'customer_id':customer['id'],'title':'Внедрение CRM',
                                          'amount_minor':300000,'stage':'new'},True)
        project=run('commerce.projects.create',{'deal_id':deal['id'],'title':'Проект CRM'},True)
        stage=run('commerce.projects.stage.add',{'project_id':project['id'],
                    'expected_version':1,'title':'Разработка'},True)
        run('commerce.projects.status',{'project_id':project['id'],
            'expected_version':2,'state':'active'},True)
        work=run('titan.work.create',{'title':'Проверить API'},True)
        link=run('titan.work.project.link',{'project_id':project['id'],'stage_id':stage['id'],
            'work_id':work['id'],'expected_version':work['version']},True)
        run('commerce.projects.stage.status',{'project_id':project['id'],
            'stage_id':stage['id'],'expected_version':1,'status':'active'},True)
        run('titan.work.status',{'id':work['id'],'expected_version':link['version'],'status':'done'},True)
        run('commerce.projects.stage.status',{'project_id':project['id'],
            'stage_id':stage['id'],'expected_version':2,'status':'done'},True)
        result=run('commerce.projects.status',{'project_id':project['id'],
            'expected_version':3,'state':'completed'},True)
        view=run('commerce.projects.get',{'project_id':project['id']})
        assert view['progress_percent']==100 and result['state']=='completed'
        print(json.dumps({'status':'M196_DEMO_PASS','project_state':result['state'],
                          'stages':len(view['stages']),'completed_stages':view['completed_stages'],
                          'progress_percent':view['progress_percent'],
                          'production_authorized':False,'real_customer_data':False},
                         ensure_ascii=False,indent=2))

if __name__=='__main__':main()
