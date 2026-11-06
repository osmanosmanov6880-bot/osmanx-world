"""Reproducible local artifacts and strictly offline, hash-pinned dependencies."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

from campaign180.repro import (build_package,verify_package,sign_package,
                               verify_signature,PackageError)
from campaign180.offline_deps import (inspect_offline_wheelhouse,
                                     restore_into_empty_target,DependencyError)

REPO=Path(__file__).resolve().parents[3]


class ArtifactTests(unittest.TestCase):
    def test_archive_repeats_byte_identically_and_verifies_sources(self):
        x=build_package(REPO)
        y=build_package(REPO)
        self.assertEqual(x,y)
        self.assertEqual(hashlib.sha256(x).digest(),hashlib.sha256(y).digest())
        output=verify_package(x)
        self.assertTrue(output['deterministic'])
        self.assertGreater(output['files'],4)
        self.assertFalse(output['signature_verified'])
        self.assertFalse(output['production_release_authorized'])

    def test_wrong_commit_is_rejected(self):
        raw=build_package(REPO)
        with self.assertRaises(PackageError):
            verify_package(raw,expected_commit='0'*40)

    def test_modified_gzip_bytes_and_trailing_data_rejected(self):
        raw=build_package(REPO)
        with self.assertRaises(PackageError):verify_package(raw+b'BAD')
        with self.assertRaises(PackageError):verify_package(raw[:25])
        with self.assertRaises(PackageError):verify_package(raw[:5]+b'x'+raw[6:])

    def test_path_traversal_and_unlisted_archive_rejected(self):
        raw=build_package(REPO)
        with gzip.GzipFile(fileobj=io.BytesIO(raw),mode='rb') as inp:
            tar_bytes=inp.read()
        inner=io.BytesIO()
        with tarfile.open(fileobj=inner,mode='w') as archive:
            info=tarfile.TarInfo('BUILD_MANIFEST.json')
            payload=b'{}'
            info.size=len(payload)
            archive.addfile(info,io.BytesIO(payload))
            info=tarfile.TarInfo('../passwords')
            info.size=2
            archive.addfile(info,io.BytesIO(b'xx'))
        zipped=io.BytesIO()
        with gzip.GzipFile(fileobj=zipped,mode='wb',mtime=0) as out:
            out.write(inner.getvalue())
        with self.assertRaises(PackageError):verify_package(zipped.getvalue())

    @unittest.skipUnless(shutil.which('openssl'),'OpenSSL unavailable')
    def test_ed25519_detached_signature_verifies_and_detects_wrong_key(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            priv=root/'private.pem';pub=root/'public.pem';pub2=root/'other.pem'
            subprocess.run(['openssl','genpkey','-algorithm','ed25519','-out',str(priv)],
                           check=True,capture_output=True)
            subprocess.run(['openssl','pkey','-in',str(priv),'-pubout','-out',str(pub)],
                           check=True,capture_output=True)
            other=root/'other_private.pem'
            subprocess.run(['openssl','genpkey','-algorithm','ed25519','-out',str(other)],
                           check=True,capture_output=True)
            subprocess.run(['openssl','pkey','-in',str(other),'-pubout','-out',str(pub2)],
                           check=True,capture_output=True)
            archive=build_package(REPO)
            sig=sign_package(archive,private_key=priv)
            self.assertEqual(len(sig),64)
            self.assertTrue(verify_signature(archive,sig,public_key=pub))
            self.assertFalse(verify_signature(archive,sig,public_key=pub2))
            self.assertFalse(verify_signature(archive,sig[:-1]+b'!',public_key=pub2))


class OfflineWheelTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name)
        self.wheels=self.base/'wheels';self.wheels.mkdir()
        self.req=self.base/'locked.txt'
        self.wheel=self.wheels/'sample_pkg-1.2.3-py3-none-any.whl'
        self.wheel.write_bytes(b'standalone fixture, not an installable wheel')
        self.hash=hashlib.sha256(self.wheel.read_bytes()).hexdigest()
        self.req.write_text('sample-pkg==1.2.3 --hash=sha256:'+self.hash+'\n',encoding='utf-8')

    def test_exact_wheel_is_verified_without_install_or_network(self):
        data=inspect_offline_wheelhouse(self.req,self.wheels)
        self.assertEqual(len(data['offline_packages']),1)
        self.assertTrue(data['wheels_verified'])
        self.assertFalse(data['network_access_required'])
        self.assertFalse(data['installed'])
        self.assertFalse(data['upstream_test_dependencies_restored'])

    def test_tampered_wheel_rejected(self):
        self.wheel.write_bytes(self.wheel.read_bytes()+b'mutated')
        with self.assertRaises(DependencyError):
            inspect_offline_wheelhouse(self.req,self.wheels)

    def test_missing_required_wheel_rejected(self):
        self.wheel.unlink()
        with self.assertRaises(DependencyError):
            inspect_offline_wheelhouse(self.req,self.wheels)

    def test_hash_missing_floating_version_options_and_urls_denied(self):
        for line in ['sample-pkg>=1.2.3',
                     'sample-pkg==1.2.3',
                     '--index-url https://example.com',
                     '-e git+https://example.com/pkg',
                     'sample-pkg==1.2.3 --hash=sha256:INVALID']:
            with self.subTest(line=line):
                self.req.write_text(line+'\n')
                with self.assertRaises(DependencyError):
                    inspect_offline_wheelhouse(self.req,self.wheels)

    def test_duplicate_name_rejected(self):
        self.req.write_text(self.req.read_text()*2)
        with self.assertRaises(DependencyError):
            inspect_offline_wheelhouse(self.req,self.wheels)

    def test_symlinked_wheel_and_unsafe_target_rejected(self):
        self.wheel.unlink()
        raw=self.base/'original.whl';raw.write_bytes(b'wheeldata')
        self.wheel.symlink_to(raw)
        with self.assertRaises(DependencyError):
            inspect_offline_wheelhouse(self.req,self.wheels)
        self.wheel.unlink()
        self.wheel.write_bytes(b'standalone fixture, not an installable wheel')
        with self.assertRaises(DependencyError):
            restore_into_empty_target(self.req,self.wheels,self.wheels)

    def test_installer_cannot_overwrite_existing_target(self):
        target=self.base/'installed';target.mkdir()
        (target/'important.txt').write_text('keep')
        with self.assertRaises(DependencyError):
            restore_into_empty_target(self.req,self.wheels,target)
        self.assertEqual((target/'important.txt').read_text(),'keep')


if __name__=="__main__":
    unittest.main()
