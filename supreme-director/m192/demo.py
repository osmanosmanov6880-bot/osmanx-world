"""Generate one purely synthetic multi-domain demonstration report."""
from pathlib import Path
from tempfile import TemporaryDirectory
from osgard_m192 import Director
import json


def main():
    with TemporaryDirectory(prefix='osgard-m192-demo-') as folder:
        engine=Director(Path(folder)/'demo.sqlite',clock=lambda:1_800_000_000)
        engine.initialize()
        owner=engine.provision('Synthetic company','demo-owner')['token']
        other=engine.provision('Different company','demo-other')['token']
        n=0
        def run(operation,payload=None,token=None):
            nonlocal n
            n+=1
            return engine.execute(token or owner,operation,payload or {},f'demo-request-{n:06}')
        customer=run('commerce.customers.create',{'name':'Test client','contact':'synthetic@example.invalid'})
        task=run('titan.tasks.create',{'title':'Complete synthetic integration walkthrough'})
        deal=run('commerce.deals.create',{'customer_id':customer['id'],'title':'Reference deal','amount_minor':25000,'stage':'proposal'})
        booking=run('experience.book',{'customer_id':customer['id'],'resource':'room-A',
                                       'start_at':1_800_000_100,'end_at':1_800_000_900})
        decision=run('nexus.decisions.create',{'question':'Choose customer onboarding path',
                   'alternatives':['guided','selfserve'],'chosen':'guided','rationale':'Synthetic A/B baseline'})
        scene=run('genesis.scenes.save',{'scene_id':'intro','expected_version':0,
                   'nodes':[{'id':'camera','kind':'camera','position':[0,0,4]}]})
        cmd=run('orbital.emulator.enqueue',{'terminal':'research-01','nonce':'demo-nonce-00001',
                     'expires_at':1_800_001_000,'command':'PING_SIMULATED'})
        run('orbital.emulator.ack',{'command_id':cmd['id'],'phase':'transport'})
        run('orbital.emulator.ack',{'command_id':cmd['id'],'phase':'execution'})
        result={
          'schema':'osgard.m192.synthetic-demo/1',
          'mode':'LOCAL_SIMULATION_ONLY',
          'systems':['TITAN','NEXUS','COMMERCE','EXPERIENCE','GENESIS','ORBITAL'],
          'created':{'task':task['id'],'customer':customer['id'],'deal':deal['id'],
                     'booking':booking['id'],'decision':decision['id'],'scene_version':scene['version'],
                     'sim_command':cmd['id']},
          'tenant_isolation':len(run('commerce.customers.list',token=other)['customers'])==0,
          'orbital_execution_ack':run('orbital.emulator.list')['commands'][0]['execution_ack']==1,
          'production_authorized':False,
          'original_180_tasks_independently_accepted':0
        }
        assert result['tenant_isolation'] and result['orbital_execution_ack']
        print(json.dumps(result,sort_keys=True,indent=2))


if __name__=='__main__':
    main()
