"""Reproducible packaging checks for *engineering* source, no production claim."""
import hashlib
from pathlib import Path
import tempfile
import unittest
import zipfile
from scripts import pack_m183


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir=Path(self.tmp.name)
        self.source=self.dir/'source'
        self.source.mkdir()
        (self.source/'README.md').write_text('OSGARD M183 engineering only',encoding='utf-8')
        (self.source/'folder').mkdir()
        (self.source/'folder/test.py').write_bytes(b'print(1)\n')

    def test_build_and_verify(self):
        x=pack_m183.build(self.source,self.dir/'a.zip')
        self.assertEqual(x['files'],3)
        self.assertTrue(pack_m183.verify(self.dir/'a.zip')['verified'])

    def test_deterministic_second_archive(self):
        a=pack_m183.build(self.source,self.dir/'a.zip')
        b=pack_m183.build(self.source,self.dir/'b.zip')
        self.assertEqual(a['sha256'],b['sha256'])

    def test_reject_overwrite(self):
        path=self.dir/'a.zip'
        pack_m183.build(self.source,path)
        with self.assertRaises(FileExistsError): pack_m183.build(self.source,path)

    def test_ignores_python_cache(self):
        d=self.source/'__pycache__';d.mkdir();(d/'x.pyc').write_bytes(b'x')
        x=pack_m183.build(self.source,self.dir/'a.zip')
        self.assertEqual(x['files'],3)

    def test_reject_symlink(self):
        (self.source/'alias').symlink_to(self.source/'README.md')
        with self.assertRaises(ValueError): pack_m183.build(self.source,self.dir/'a.zip')

    def test_reject_empty(self):
        for file in self.source.rglob('*'):
            if file.is_file():file.unlink()
        with self.assertRaises(ValueError): pack_m183.build(self.source,self.dir/'a.zip')

    def test_reject_missing_manifest(self):
        p=self.dir/'a.zip'
        with zipfile.ZipFile(p,'w') as z:z.writestr('README.md',b'x')
        with self.assertRaises(ValueError):pack_m183.verify(p)

    def test_reject_extra_member(self):
        p=self.dir/'a.zip'
        with zipfile.ZipFile(p,'w') as z:
            z.writestr('SHA256SUMS.txt',hashlib.sha256(b'a').hexdigest()+'  a.txt\n')
            z.writestr('a.txt',b'a')
            z.writestr('extra.txt',b'b')
        with self.assertRaises(ValueError):pack_m183.verify(p)

    def test_reject_wrong_hash(self):
        p=self.dir/'a.zip'
        with zipfile.ZipFile(p,'w') as z:
            z.writestr('SHA256SUMS.txt','f'*64+'  a.txt\n')
            z.writestr('a.txt',b'a')
        with self.assertRaises(ValueError):pack_m183.verify(p)

    def test_manifest_contains_exact_original_bytes(self):
        p=self.dir/'a.zip';pack_m183.build(self.source,p)
        with zipfile.ZipFile(p) as z:
            self.assertIn(hashlib.sha256(b'print(1)\n').hexdigest()+'  folder/test.py',z.read('SHA256SUMS.txt').decode())

    def test_invalid_source_type(self):
        with self.assertRaises(ValueError):pack_m183.sources(self.dir/'nope')


if __name__=='__main__':unittest.main()
