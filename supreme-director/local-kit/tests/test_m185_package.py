"""M185 archive byte-level reproducibility and verification negatives."""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
import warnings
from scripts.pack_m185 import artifact_bytes, pack_files, rel_check, verify_zip, PARENT_SHA
BASE=Path(__file__).resolve().parents[1]


class PackageTests(unittest.TestCase):
    @staticmethod
    def payload():
        return {'README.md':b'# synthetic demo',
                'osgard_m185/review.py':b'# synthetic source',
                'tests/test_m185.py':b'# synthetic tests'}

    def test_parent_pinned(self):
        p=BASE/'inputs/OSGARD_M184_PARENT_UNMODIFIED.zip'
        self.assertEqual(hashlib.sha256(p.read_bytes()).hexdigest(),PARENT_SHA)

    def test_two_zip_builds_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            a=Path(tmp)/'a.zip';b=Path(tmp)/'b.zip'
            x=pack_files(self.payload(),a);y=pack_files(self.payload(),b)
            self.assertEqual(x['status'],'LOCAL_ARCHIVE_VERIFIED')
            self.assertEqual(x['sha256'],y['sha256'])
            self.assertEqual(a.read_bytes(),b.read_bytes())

    def test_corrupt_hash_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/'a.zip';pack_files(self.payload(),file)
            with zipfile.ZipFile(file) as z:
                parts={x.filename:z.read(x.filename) for x in z.infolist()}
            parts['osgard_m185/review.py']=b'malicious replacement'
            with zipfile.ZipFile(file,'w') as z:
                for name,data in parts.items():z.writestr(name,data)
            with self.assertRaises(ValueError):verify_zip(file)

    def test_duplicate_zip_entries_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/'a.zip';pack_files(self.payload(),file)
            with warnings.catch_warnings():
                warnings.filterwarnings('ignore',message='Duplicate name:')
                with zipfile.ZipFile(file,'a') as z:z.writestr('README.md',b'duplicated')
            with self.assertRaises(ValueError):verify_zip(file)

    def test_traversal_rejected(self):
        for name in ['../x','/absolute','sub/../bad','a\\b','a//b','.git/config']:
            with self.subTest(name=name), self.assertRaises(ValueError):rel_check(name)

    def test_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/'a.zip';pack_files(self.payload(),file)
            with zipfile.ZipFile(file) as z:parts={i.filename:z.read(i.filename) for i in z.infolist()}
            with zipfile.ZipFile(file,'w') as z:
                for name,data in parts.items():
                    info=zipfile.ZipInfo(name);info.create_system=3
                    info.external_attr=(0o120777 << 16) if name=='README.md' else (0o100644 << 16)
                    z.writestr(info,data)
            with self.assertRaises(ValueError):verify_zip(file)

    def test_missing_entry_rejected(self):
        obj=self.payload();obj.pop('README.md')
        with self.assertRaises(ValueError):artifact_bytes(obj)

    def test_unrecognized_schema_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/'a.zip';pack_files(self.payload(),file)
            with zipfile.ZipFile(file) as z:parts={i.filename:z.read(i.filename) for i in z.infolist()}
            man=json.loads(parts['MANIFEST.json']);man['schema']='fake-production-release'
            parts['MANIFEST.json']=json.dumps(man).encode()
            with zipfile.ZipFile(file,'w') as z:
                for name,data in parts.items():z.writestr(name,data)
            with self.assertRaises(ValueError):verify_zip(file)


if __name__=='__main__':unittest.main()
