import io
import json
from pathlib import Path
import tempfile
import unittest
import warnings
import zipfile
from scripts.pack_m184 import artifact_bytes, digest, pack_files, rel_check, verify_zip, build_payload

PAYLOAD={'README.md': b'local tool', 'osgard_m184/storage.py': b'python source', 'tests/test_m184.py': b'unittest source'}


class TestPackage(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.p=Path(self.tmp.name)

    def test_roundtrip(self):
        out=self.p/'pkg.zip'; r=pack_files(PAYLOAD,out)
        self.assertEqual(r['status'],'LOCAL_ARCHIVE_VERIFIED')
        self.assertEqual(r['files'],5)
        self.assertEqual(verify_zip(out)['production'],'NO_GO')

    def test_determinism(self):
        a,b=self.p/'a.zip',self.p/'b.zip'
        pack_files(PAYLOAD,a);pack_files(dict(reversed(list(PAYLOAD.items()))),b)
        self.assertEqual(digest(a.read_bytes()),digest(b.read_bytes()))

    def test_zip_traversal_path(self):
        for path in ['../evil','/root/unsafe','a/../../b','a//b','a\\b','.git/config']:
            with self.subTest(path=path):
                with self.assertRaises(ValueError):rel_check(path)

    def test_reserved_manifest(self):
        with self.assertRaises(ValueError):artifact_bytes({**PAYLOAD,'MANIFEST.json':b'evil'})

    def test_missing_required_payload(self):
        with self.assertRaises(ValueError):artifact_bytes({'README.md':b'x'})

    def test_duplicate_zip_rejected(self):
        out=self.p/'duplicate.zip'
        with warnings.catch_warnings():
            warnings.filterwarnings('ignore', message='Duplicate name:.*', category=UserWarning)
            with zipfile.ZipFile(out,'w') as z:
                z.writestr('README.md',b'a');z.writestr('README.md',b'b')
                z.writestr('MANIFEST.json',b'{}');z.writestr('SHA256SUMS.txt',b'x')
        with self.assertRaises(ValueError):verify_zip(out)

    def test_missing_manifest(self):
        out=self.p/'missing.zip'
        with zipfile.ZipFile(out,'w') as z:
            z.writestr('README.md',b'x');z.writestr('osgard_m184/storage.py',b'a');z.writestr('SHA256SUMS.txt',b'bad')
        with self.assertRaises(ValueError):verify_zip(out)

    def test_invalid_member_contents(self):
        out=self.p/'tamper.zip'
        clean=artifact_bytes(PAYLOAD)
        with zipfile.ZipFile(out,'w') as z:
            for name, bytes_ in clean.items():
                z.writestr(name,b'tampered' if name=='README.md' else bytes_)
        with self.assertRaises(ValueError):verify_zip(out)

    def test_actual_parent_pinned_hash(self):
        root=Path(__file__).resolve().parents[1]
        self.assertEqual(digest((root/'inputs/OSGARD_M183_PARENT_UNMODIFIED.zip').read_bytes()),
                         'c48e2996016ca61a9846c74c72dfdfa20c6b28386ab2ec72e5a10d59fee6cbde')

    def test_pack_src_has_control_plane(self):
        root=Path(__file__).resolve().parents[1]
        raw=build_payload(root)
        self.assertIn('osgard_m184/api.py',raw)
        self.assertIn('dashboard/m184/studio.js',raw)
        self.assertNotIn('runtime/control.db',raw)


if __name__=='__main__':unittest.main()
