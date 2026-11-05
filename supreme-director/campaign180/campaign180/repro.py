"""TITAN-X04 local reproducible source package + optional Ed25519 signature.

Immutable git commit, clean tracked worktree, deterministic tar/gzip metadata,
manifested paths and independent offline verification. Key custody and CI
release attestations are NOT implemented; this never publishes a release.
"""
from __future__ import annotations

import argparse
from hashlib import sha256
import gzip
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile

from .contracts import canonical
from .registry import git_files, EvidenceError

SCHEMA = "osgard.original180.local-package/1"
SOURCE_PREFIX = "supreme-director/campaign180/"
EXTRA = frozenset(("supreme-director/originals/DIRECTOR_MASTER_180.md",
                   "supreme-director/recovery/ORIGINAL_180_TASKS.json"))
MAX_FILE = 8 * 1024 * 1024
MAX_TAR = 48 * 1024 * 1024
MAX_PACKAGE = 24 * 1024 * 1024
MAX_MEMBERS = 1500
MANIFEST = "BUILD_MANIFEST.json"
HEX40 = re.compile(r"^[0-9a-f]{40}$")


class PackageError(ValueError):
    pass


def _path_ok(path: str) -> bool:
    if type(path) is not str or not path or "\\" in path or "\x00" in path:
        return False
    parts = PurePosixPath(path).parts
    return (not path.startswith("/") and "." not in parts and ".." not in parts
            and (path.startswith(SOURCE_PREFIX) or path in EXTRA)
            and not path.endswith("/") and not path.startswith("./"))


def _render(manifest: dict, contents: dict[str, bytes]) -> bytes:
    manifest_bytes = canonical(manifest) + b"\n"
    inner = io.BytesIO()
    with tarfile.open(fileobj=inner, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name, body in [(MANIFEST, manifest_bytes)] + sorted(contents.items()):
            info = tarfile.TarInfo(name)
            info.size = len(body)
            info.mtime = 0
            info.uid = 0
            info.gid = 0
            info.mode = 0o644
            info.uname = ""
            info.gname = ""
            info.pax_headers = {}
            tar.addfile(info, io.BytesIO(body))
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", filename="", compresslevel=9, mtime=0) as zipstream:
        zipstream.write(inner.getvalue())
    result = out.getvalue()
    if len(result) > MAX_PACKAGE:
        raise PackageError("Compressed package exceeds cap")
    return result


def _commit(root: Path) -> str:
    outcome = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"],
                             capture_output=True, text=True, timeout=15, check=False)
    if outcome.returncode or not HEX40.fullmatch(outcome.stdout.strip()):
        raise PackageError("No immutable git source commit")
    return outcome.stdout.strip()


def build_package(root: Path) -> bytes:
    root = Path(root).resolve()
    commit = _commit(root)
    selected = [name for name in git_files(root) if _path_ok(name)]
    if not selected or len(selected) > MAX_MEMBERS - 1 or not EXTRA.issubset(set(selected)):
        raise PackageError("Source files and original 180 master must be tracked")
    diff = subprocess.run(["git", "-C", str(root), "diff", "--quiet", "HEAD", "--"] + selected,
                          capture_output=True, timeout=15, check=False)
    if diff.returncode != 0:
        raise PackageError("Cannot package a dirty or unverified tracked worktree")
    contents: dict[str, bytes] = {}
    total = 0
    for name in selected:
        path = root / name
        if path.is_symlink() or not path.is_file():
            raise PackageError("Nonregular tracked source")
        data = path.read_bytes()
        if len(data) > MAX_FILE:
            raise PackageError("Oversized tracked file")
        contents[name] = data
        total += len(data)
    if total > MAX_TAR - 2048:
        raise PackageError("Sources exceed uncompressed limit")
    manifest = {"schema": SCHEMA, "source_commit": commit, "files": [
        {"path": name, "bytes": len(contents[name]), "sha256": sha256(contents[name]).hexdigest()}
        for name in sorted(contents)]}
    return _render(manifest, contents)


def verify_package(package: bytes, *, expected_commit: str | None = None) -> dict:
    if type(package) is not bytes or not 0 < len(package) <= MAX_PACKAGE:
        raise PackageError("Invalid compressed archive")
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(package), mode="rb") as gz:
            raw = gz.read(MAX_TAR + 1)
        if len(raw) > MAX_TAR:
            raise PackageError("Uncompressed archive exceeds cap")
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as tar:
            members = tar.getmembers()
            if not 1 < len(members) <= MAX_MEMBERS:
                raise PackageError("Unexpected member count")
            names = [m.name for m in members]
            if len(set(names)) != len(names) or names[0] != MANIFEST:
                raise PackageError("Missing or duplicate manifest")
            if any(not m.isfile() or m.uid != 0 or m.gid != 0 or m.mtime != 0
                   or m.mode != 0o644 or m.uname or m.gname or
                   (m.name != MANIFEST and not _path_ok(m.name)) or
                   m.size > MAX_FILE for m in members):
                raise PackageError("Archive contains unsafe or noncanonical member")
            payloads = {m.name: tar.extractfile(m).read() for m in members}
        manifest = json.loads(payloads.pop(MANIFEST).decode("utf-8"))
        if (type(manifest) is not dict or set(manifest) != {"schema","source_commit","files"}
                or manifest["schema"] != SCHEMA
                or type(manifest["source_commit"]) is not str
                or not HEX40.fullmatch(manifest["source_commit"])
                or (expected_commit is not None and expected_commit != manifest["source_commit"])
                or type(manifest["files"]) is not list):
            raise PackageError("Invalid source manifest")
        records = manifest["files"]
        reconstructed = [{"path": name, "bytes": len(value), "sha256": sha256(value).hexdigest()}
                         for name,value in sorted(payloads.items())]
        if records != reconstructed or not EXTRA.issubset(payloads):
            raise PackageError("Manifest mismatch or missing original source")
        # This also rejects extra gzip members, trailing bytes and alternate gzip metadata.
        if _render(manifest, payloads) != package:
            raise PackageError("Archive is not in canonical reproducible format")
        return {"schema": SCHEMA, "source_commit": manifest["source_commit"],
                "files": len(records), "archive_sha256": sha256(package).hexdigest(),
                "deterministic": True, "signature_verified": False,
                "production_release_authorized": False}
    except (OSError, EOFError, tarfile.TarError, UnicodeError, json.JSONDecodeError,
            KeyError, AttributeError, TypeError) as exc:
        raise PackageError("Corrupt or unsafe source archive") from exc


def _openssl(op: str, package: bytes, key_path: Path, signature: bytes | None = None) -> bytes | bool:
    if not shutil.which("openssl"):
        raise PackageError("OpenSSL required for Ed25519")
    if not key_path.is_file():
        raise PackageError("Explicit signing/verifier key missing")
    with tempfile.TemporaryDirectory(prefix="osgard-sign-") as temp:
        directory = Path(temp)
        message = directory / "archive.sha256.bin"
        signature_file = directory / "sig.bin"
        message.write_bytes(sha256(package).digest())
        if signature is not None:
            signature_file.write_bytes(signature)
        if op == "sign":
            argv = ["openssl","pkeyutl","-sign","-rawin","-inkey",str(key_path),
                    "-in",str(message),"-out",str(signature_file)]
        elif op == "verify":
            argv = ["openssl","pkeyutl","-verify","-rawin","-pubin","-inkey",
                    str(key_path),"-in",str(message),"-sigfile",str(signature_file)]
        else:
            raise PackageError("Unknown signature operation")
        try:
            proc = subprocess.run(argv, capture_output=True, timeout=20, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise PackageError("OpenSSL unavailable") from exc
        if proc.returncode:
            if op == "verify":
                return False
            raise PackageError("Ed25519 private key rejected by OpenSSL")
        return signature_file.read_bytes() if op == "sign" else True


def sign_package(package: bytes, *, private_key: Path) -> bytes:
    verify_package(package)
    output = _openssl("sign", package, Path(private_key))
    if type(output) is not bytes or len(output) != 64:
        raise PackageError("Expected Ed25519 detached signature")
    return output


def verify_signature(package: bytes, signature: bytes, *, public_key: Path) -> bool:
    verify_package(package)
    if type(signature) is not bytes or len(signature) != 64:
        return False
    return _openssl("verify",package,Path(public_key),signature) is True


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Local artifact packager, never a deploy command")
    parser.add_argument("command",choices=("build","verify","sign","verify-signature"))
    parser.add_argument("--root",type=Path,default=Path("."))
    parser.add_argument("--archive",type=Path,required=True)
    parser.add_argument("--key",type=Path)
    parser.add_argument("--signature",type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            blob = build_package(args.root)
            args.archive.parent.mkdir(parents=True, exist_ok=True)
            args.archive.write_bytes(blob)
        else:
            blob = args.archive.read_bytes()
        result = verify_package(blob)
        if args.command == "sign":
            if not args.key or not args.signature:
                raise PackageError("Explicit key and signature output required")
            args.signature.write_bytes(sign_package(blob,private_key=args.key))
        if args.command == "verify-signature":
            if not args.key or not args.signature or not verify_signature(
                    blob,args.signature.read_bytes(),public_key=args.key):
                raise PackageError("Detached signature invalid")
            result["signature_verified"] = True
        print(json.dumps(result,sort_keys=True))
        return 0
    except (PackageError,EvidenceError,OSError) as exc:
        parser.exit(2,"FAIL_CLOSED: "+str(exc)+"\n")


if __name__ == "__main__":
    raise SystemExit(main())
