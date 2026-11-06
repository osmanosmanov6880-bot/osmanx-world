"""Small local diagnostic only; NOT a production SLO/performance certification."""
from __future__ import annotations
import http.client
import json
from pathlib import Path
import statistics
import sys
import tempfile
import threading
from time import perf_counter

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BASE))
from osgard_m184.api import serve
from osgard_m184.storage import DirectorDB
TOKEN='synthetic-local-benchmark-long-token-1234'


def percentile(values, p):
    values = sorted(values)
    return round(values[min(len(values)-1,int((len(values)-1)*p))]*1000,3)


def run():
    with tempfile.TemporaryDirectory() as d:
        db=DirectorDB(Path(d)/'temp.sqlite3')
        db.bootstrap(BASE/'docs/M182_WORKPLAN_180_PROPOSED.json', BASE/'templates/CONFLICTS_PROVISIONAL.json',
                     BASE/'templates/CONTRACTS_PROVISIONAL.json', BASE/'docs/m183/CURRENT_GITHUB_DEFAULT_BRANCH_OBSERVATIONS_2026-10-27.json')
        server,_=serve(db.path, BASE/'dashboard/m184', 0, TOKEN)
        t=threading.Thread(target=server.serve_forever,daemon=True);t.start()
        try:
            delays=[]
            started=perf_counter()
            for _ in range(160):
                c=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
                a=perf_counter()
                c.request('GET','/api/v1/summary',headers={'Authorization':'Bearer '+TOKEN})
                r=c.getresponse(); body=r.read();c.close()
                if r.status!=200 or json.loads(body)['data']['counts']['tasks']!=180:
                    raise ValueError('benchmark response mismatch')
                delays.append(perf_counter()-a)
            elapsed=perf_counter()-started
            report={'scope':'LOCAL_LOOPBACK_SINGLE_PROCESS_DIAGNOSTIC_ONLY',
                    'requests':len(delays),'concurrency':1,'p50_ms':percentile(delays,0.5),
                    'p95_ms':percentile(delays,0.95),'p99_ms':percentile(delays,0.99),
                    'requests_per_sec':round(len(delays)/elapsed,1),
                    'tool_version':'M184','git_product_integration':False,
                    'prod_slo_certification':False,'database_integrity':db.doctor()['health']}
        finally:
            server.shutdown();server.server_close();t.join(timeout=2)
    (BASE/'evidence/m184/LOCAL_LOOPBACK_BENCHMARK.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))

if __name__=='__main__':run()
