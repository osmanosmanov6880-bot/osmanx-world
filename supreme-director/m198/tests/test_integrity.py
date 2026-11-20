"""M198 manifest, fake source and UI regression guard."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

HERE=Path(__file__).resolve().parents[1]

class IntegrityTests(unittest.TestCase):
    def test_manifest_present(self):
        data=json.loads((HERE/'M198_SOURCE_MANIFEST.json').read_text('utf-8'))
        self.assertEqual(data['schema'],'osgard.m198.source-manifest/1')
        self.assertIn('osgard_m198/runtime.py',data['files'])
    def test_verified_source(self):
        proc=subprocess.run(['python3',str(HERE/'verify_source.py')],capture_output=True,text=True,timeout=5)
        self.assertEqual(proc.returncode,0,proc.stdout+'\n'+proc.stderr)
    def test_local_only_ui(self):
        html=(HERE/'osgard_m198/web/index.html').read_text('utf-8')
        js=(HERE/'osgard_m198/web/app.js').read_text('utf-8')
        self.assertIn('Финансовый контроль',html)
        self.assertIn('/v1/execute',js)
        self.assertNotIn('https://',html)
        self.assertIn('commerce.finance.snapshot',js)
        self.assertNotIn('localStorage',js)

if __name__=='__main__':unittest.main()
