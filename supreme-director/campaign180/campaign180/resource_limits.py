"""Local-only fixed resource bounds for an allowlisted computational worker.

TITAN-X10 partial proof: actual Linux RLIMIT and parent wall-clock deadline.
Not a general OS/container isolation boundary, no arbitrary code or network.
"""
from __future__ import annotations
from dataclasses import dataclass
import os

class ResourceDenied(ValueError):
    pass

@dataclass(frozen=True)
class ResourceLimits:
    cpu_seconds: int = 2
    wall_ms: int = 3500
    memory_mb: int = 128
    input_bytes: int = 16384
    output_bytes: int = 8192
    max_operations: int = 64
    disk_bytes: int = 0
    network_bytes: int = 0

    def checked(self) -> "ResourceLimits":
        for key,lo,hi in (
            ("cpu_seconds",1,5),("wall_ms",250,10000),
            ("memory_mb",64,256),("input_bytes",256,16384),
            ("output_bytes",256,32768),("max_operations",1,128)):
            value=getattr(self,key)
            if type(value) is not int or not lo<=value<=hi:
                raise ResourceDenied("Unsupported limit: "+key)
        if self.disk_bytes != 0 or self.network_bytes != 0 or (
            type(self.disk_bytes) is not int or type(self.network_bytes) is not int
        ):
            raise ResourceDenied("Disk and network operations are not authorized")
        if os.name!="posix":
            raise ResourceDenied("Worker resource enforcement requires POSIX RLIMIT")
        try:
            import resource
            for key in ("RLIMIT_AS","RLIMIT_CPU","RLIMIT_CORE","RLIMIT_FSIZE","RLIMIT_NOFILE"):
                if not hasattr(resource,key):
                    raise ResourceDenied("Missing kernel resource enforcement "+key)
        except ImportError as exc:
            raise ResourceDenied("resource module required for enforcement") from exc
        return self

    def worker_rlimits(self) -> None:
        """Called inside the isolated process immediately before exec()."""
        self.checked()
        import resource
        def apply(key,soft,hard):
            resource.setrlimit(key,(soft,hard))
        apply(resource.RLIMIT_CPU,self.cpu_seconds,self.cpu_seconds+1)
        apply(resource.RLIMIT_AS,self.memory_mb*1024*1024,self.memory_mb*1024*1024)
        apply(resource.RLIMIT_CORE,0,0)
        apply(resource.RLIMIT_FSIZE,0,0)
        apply(resource.RLIMIT_NOFILE,32,32)
