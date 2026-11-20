"""TITAN-X04: reproducible source build + TRUST-PINNED Ed25519 check.

Uses existing deterministic package builder. A signature counts only if
the supplied public key's DER fingerprint matches the separately specified
trust anchor. Self-generated CI keys test mechanics, NOT product release.
No publish, deploy, private-key storage, or network access.
"""
from __future__ import annotations
import argparse
from hashlib import sha256
import hmac
import json
from pathlib import Path
import re
import shutil
import subprocess
from .registry import EvidenceError,load_upstreams
from .repro import build_package,verify_package,verify_signature,PackageError
from .titan_baseline import snapshot

SHA64=re.compile(r"^[a-f0-9]{64}$")

class ArtifactDenied(ValueError):
    pass

def public_key_fingerprint(public_key:Path)->str:
    if not shutil.which("openssl"):
        raise ArtifactDenied("OpenSSL unavailable for Ed25519 verification")
    if not public_key.is_file() or public_key.is_symlink() or public_key.stat().st_size>4096:
        raise ArtifactDenied("Explicit regular trusted public key required")
    try:
        result=subprocess.run(["openssl","pkey","-pubin","-in",str(public_key),
                               "-outform","DER"],capture_output=True,
                              check=False,timeout=12)
    except (OSError,subprocess.TimeoutExpired) as exc:
        raise ArtifactDenied("Public key check unavailable") from exc
    if result.returncode or not result.stdout or len(result.stdout)>2048:
        raise ArtifactDenied("Ed25519 public key parse failed")
    # Minimal DER SubjectPublicKeyInfo for Ed25519: 12-byte algorithm/name
    # prefix and 32-byte raw key. Reject RSA/ECDSA substitution.
    if len(result.stdout)!=44 or not result.stdout.startswith(
        bytes.fromhex("302a300506032b6570032100")):
        raise ArtifactDenied("Ed25519 public key required")
    return sha256(result.stdout).hexdigest()

def verify_reproducible_signed(root:Path,archive:bytes,signature:bytes,
                               *,public_key:Path,expected_key_sha256:str)->dict:
    if type(expected_key_sha256) is not str or not SHA64.fullmatch(expected_key_sha256):
        raise ArtifactDenied("Pinned independent key fingerprint required")
    baseline=snapshot(root)
    file_sha=public_key_fingerprint(public_key)
    if not hmac.compare_digest(file_sha,expected_key_sha256):
        raise ArtifactDenied("Signer is not the pinned trust key")
    first=build_package(root)
    second=build_package(root)
    if first!=second or type(archive) is not bytes or archive!=first:
        raise ArtifactDenied("Artifact is not byte-reproducible from current commit")
    report=verify_package(archive,expected_commit=baseline["checkout_commit"])
    if not verify_signature(archive,signature,public_key=public_key):
        raise ArtifactDenied("Signed digest could not be verified")
    source=load_upstreams(root)["teams"]["TITAN"]
    return {"schema":"osgard.original180.titan-signed-build/1",
            "task_id":"TITAN-X04","checkout_sha":baseline["checkout_commit"],
            "checkout_tree":baseline["checkout_tree"],
            "archive_sha256":report["archive_sha256"],
            "ed25519_key_der_sha256":file_sha,
            "signature_valid":True,"byte_reproduced_twice":True,
            "source_file_count":report["files"],
            "canonical_upstream_approved":source["owner_approved"] is True,
            "status":"BLOCKED_UPSTREAM" if baseline["status"]=="BLOCKED_UPSTREAM"
                     else "READY_FOR_REVIEW",
            "independently_accepted":False,"production_release_authorized":False}

def main(argv=None):
    parser=argparse.ArgumentParser(description="TITAN-X04 trusted offline reproducibility")
    parser.add_argument("--root",type=Path,default=Path("."))
    parser.add_argument("--archive",type=Path,required=True)
    parser.add_argument("--signature",type=Path,required=True)
    parser.add_argument("--public-key",type=Path,required=True)
    parser.add_argument("--trusted-key-sha256",required=True)
    opts=parser.parse_args(argv)
    result=verify_reproducible_signed(opts.root,opts.archive.read_bytes(),
        opts.signature.read_bytes(),public_key=opts.public_key,
        expected_key_sha256=opts.trusted_key_sha256)
    print(json.dumps(result,sort_keys=True))
    return 0

if __name__=="__main__":
    raise SystemExit(main())
