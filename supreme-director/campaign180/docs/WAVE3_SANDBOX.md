# TITAN-X09/X10: Rootless OCI sandbox adapter (partial)

This package adds a runnable local Podman smoke adapter behind TWO explicit
gates (constructor opt-in and OSGARD_EXPLICIT_LOCAL_SANDBOX=1).
The rootless Podman runtime must be running on non-root Linux, with seccomp and
cgroups v2. Pinned image sha256 and static command come from trusted policy,
never the task. The container disables network, mounts, privileges, writeable
rootfs and enforces configured memory, CPU, PIDs, tmpfs and deadline parameters.

Each launch reads the live fenced lease plus scoped member authorization in
the same SQLite transaction. Stdout/stderr is discarded. The adapter does not
automatically complete a queue job or send external messages. Real rootless OCI
isolation has NOT been executed or independently security-tested in CI.
Any compromise of the host OCI runtime, cgroups or selected image could
invalidate security guarantees. Do not call this a production sandbox.

Tests assert denial on disabled launch, rootful hosts, missing seccomp,
stale fences, revocation, unpinned images and excessive policies. CI uses a
mocked OCI preflight/launch only; a real rootless smoke and adversarial review
remain required. Original task acceptance: 0/180.
