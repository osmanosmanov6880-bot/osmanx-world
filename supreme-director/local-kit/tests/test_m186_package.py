"""M186 portable archive integrity and deterministic zip denial tests."""
import json
import tempfile
import unittest
from pathlib import Path
import warnings
import zipfile
from scripts.pack_m186 import artifact_bytes, pack_files, verify_zip, rel_check, PARENT_SHA

BASE=Path(__file__).resolve().parents[1]


class PackagingTests(unittest.TestCase):
    @staticmethod
    def demo():
        return {'README.md':b'# synthetic', 'osgard_m186/contracts.py':b'# synthetic source',
                'tests/test_m186.py':b'# synthetic tests'}
    def test_parent_continuity_receipt(self):
        obj=json.loads((BASE/'evidence/m186/PARENT_M185_SOURCE_CONTINUITY.json').read_text())
        self.assertEqual(obj['parent_sha256'],PARENT_SHA)
        self.assertEqual(obj['unchanged_parent_members'],153)
        self.assertFalse(obj['production_authorized'])
    def test_deterministic_zip(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'a.zip';q=Path(t)/'b.zip'
            a=pack_files(self.demo(),p);b=pack_files(self.demo(),q)
            self.assertEqual(a['sha256'],b['sha256'])
            self.assertEqual(p.read_bytes(),q.read_bytes())
            self.assertEqual(a['production'],'NO_GO')
    def test_no_duplicate_member(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'a.zip';pack_files(self.demo(),p)
            with warnings.catch_warnings():
                warnings.filterwarnings('ignore',message='Duplicate name:')
                with zipfile.ZipFile(p,'a') as z:z.writestr('README.md',b'duplicate')
            with self.assertRaises(ValueError):verify_zip(p)
    def test_no_path_traversal(self):
        for x in ('../x','/secret','a/../../b','a\\b','.git/config','a//b'):
            with self.subTest(x=x),self.assertRaises(ValueError):rel_check(x)
    def test_no_missing_source(self):
        with self.assertRaises(ValueError):artifact_bytes({'README.md':b'only'})
    def test_no_member_tampering(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'a.zip';pack_files(self.demo(),p)
            with zipfile.ZipFile(p) as z:files={i.filename:z.read(i.filename) for i in z.infolist()}
            files['tests/test_m186.py']=b'# changed'
            with zipfile.ZipFile(p,'w') as z:
                for name,data in files.items():z.writestr(name,data)
            with self.assertRaises(ValueError):verify_zip(p)
    def test_no_symlink_member(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'a.zip';pack_files(self.demo(),p)
            with zipfile.ZipFile(p) as z:files={i.filename:z.read(i.filename) for i in z.infolist()}
            with zipfile.ZipFile(p,'w') as z:
                for name,data in files.items():
                    info=zipfile.ZipInfo(name);info.create_system=3
                    info.external_attr=(0o120777 << 16) if name=='README.md' else (0o100644 << 16)
                    z.writestr(info,data)
            with self.assertRaises(ValueError):verify_zip(p)
    def test_schema_production_false(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'a.zip';pack_files(self.demo(),p)
            with zipfile.ZipFile(p) as z:files={i.filename:z.read(i.filename) for i in z.infolist()}
            manifest=json.loads(files['MANIFEST.json']);manifest['product_production']='GO'
            files['MANIFEST.json']=json.dumps(manifest).encode()
            with zipfile.ZipFile(p,'w') as z:
                for name,data in files.items():z.writestr(name,data)
            with self.assertRaises(ValueError):verify_zip(p)

if __name__=='__main__':unittest.main()
