"""Real local M192 -> M193 workflow, including HTTP/SQLite record persistence."""
import json
from pathlib import Path
import tempfile
import unittest
from osgard_m193.runtime import Director193

class Smoke(unittest.TestCase):
    def test_crm_lifecycle_on_disk(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'m193.sqlite'
            app=Director193(path,clock=lambda:1_800_000_000)
            app.initialize();owner=app.provision('Studio','founder')['token']
            customer=app.execute(owner,'commerce.customers.create',
                {'name':'Studio Customer','contact':'phone'},'create-customer-1')
            deal=app.execute(owner,'commerce.deals.create',
                {'customer_id':customer['id'],'title':'Site+CRM','amount_minor':5000000,'stage':'new'},
                'create-deal-0001')
            progress=app.execute(owner,'commerce.crm.deals.update',
                {'deal_id':deal['id'],'expected_version':1,'stage':'qualified'},'progress-deal-01')
            self.assertEqual(progress['version'],2)
            activity=app.execute(owner,'commerce.crm.activities.create',
                {'customer_id':customer['id'],'deal_id':deal['id'],'kind':'meeting',
                 'details':'Discuss business requirements','due_at':1_800_002_000},'schedule-meeting-1')
            app.execute(owner,'commerce.crm.activities.complete',
                {'activity_id':activity['id'],'expected_version':1},'complete-meeting-1')
            # Reopen the same physical database as a separate process would.
            reopened=Director193(path,clock=lambda:1_800_000_000)
            self.assertEqual(reopened.execute(owner,'commerce.crm.overview',{})['open_activities'],0)
            self.assertEqual(reopened.execute(owner,'commerce.crm.deals.list',{})['deals'][0]['stage'],'qualified')
            self.assertEqual(reopened.execute(owner,'commerce.crm.activities.list',{})['activities'][0]['status'],'done')
            self.assertEqual(reopened.execute(owner,'titan.audit.list',{})['audit'][0]['operation'],'commerce.crm.activities.complete')
            self.assertNotIn(owner,path.read_bytes().decode('utf-8',errors='ignore'))

if __name__ == '__main__':unittest.main()
