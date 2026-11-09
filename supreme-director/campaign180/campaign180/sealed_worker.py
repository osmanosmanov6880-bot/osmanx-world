"""Wave15: SHA256-pinned fixed Python worker copied into sealed Linux memfd.

The worker code is trusted, fixed and never supplied by the job. Fail
closed if Linux seals, exact hash or a protected regular file are missing.
This is not a general-purpose OS sandbox or network namespace.
"""
from __future__ import annotations
from contextlib import contextmanager
import fcntl
import hashlib
import hmac
import os
from pathlib import Path
import stat
import sys

PINNED_WORKER_SHA256="2e680978b89ecaaa0eafd5a8c4ab3578d9bdf03a3f273d15670306c58cdb4f88"
MAX_WORKER_BYTES=8192

class WorkerImageDenied(ValueError):
    pass

def source_bytes(path:Path)->bytes:
    if type(path) is not Path:
        raise WorkerImageDenied("Trusted exact Path required")
    flags=os.O_RDONLY|os.O_CLOEXEC
    if hasattr(os,"O_NOFOLLOW"):flags|=os.O_NOFOLLOW
    try:fd=os.open(path,flags)
    except OSError as exc:
        raise WorkerImageDenied("Worker source is inaccessible") from exc
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or not 0<st.st_size<=MAX_WORKER_BYTES or st.st_mode & 0o022:
            raise WorkerImageDenied("Worker must be a protected regular file")
        with os.fdopen(os.dup(fd),"rb") as f:data=f.read(MAX_WORKER_BYTES+1)
        if len(data)!=st.st_size:
            raise WorkerImageDenied("Source changed during integrity check")
    finally:os.close(fd)
    if not hmac.compare_digest(hashlib.sha256(data).hexdigest(),PINNED_WORKER_SHA256):
        raise WorkerImageDenied("Unreviewed worker source")
    return data

@contextmanager
def sealed_worker_fd(path:Path):
    if sys.platform!="linux" or not hasattr(os,"memfd_create") or not hasattr(os,"MFD_ALLOW_SEALING") or not hasattr(fcntl,"F_ADD_SEALS"):
        raise WorkerImageDenied("Sealed Linux memfd required")
    content=source_bytes(path)
    try:fd=os.memfd_create("osgard-reviewed-worker",os.MFD_CLOEXEC|os.MFD_ALLOW_SEALING)
    except OSError as exc:raise WorkerImageDenied("Anonymous worker allocation refused") from exc
    try:
        if os.write(fd,content)!=len(content):
            raise WorkerImageDenied("Worker image write incomplete")
        os.lseek(fd,0,os.SEEK_SET)
        seals=fcntl.F_SEAL_WRITE|fcntl.F_SEAL_GROW|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_SEAL
        fcntl.fcntl(fd,fcntl.F_ADD_SEALS,seals)
        if fcntl.fcntl(fd,fcntl.F_GET_SEALS)&seals!=seals:
            raise WorkerImageDenied("Kernel did not enforce memory-file seals")
        yield fd
    except OSError as exc:
        raise WorkerImageDenied("Kernel image sealing failed") from exc
    finally:os.close(fd)
