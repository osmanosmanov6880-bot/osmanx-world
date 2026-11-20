# Офлайн-образ для проверки rootless Podman на отдельном Linux-хосте

Этот OCI образ **не запускается автоматически**. Он содержит только
`campaign180/oci_probe_payload.py`, который возвращает ограниченную
JSON-сводку фактических настроек ядра внутри контейнера.

Условия перед сборкой и запуском:

- Проверенная авторизованная Linux-машина без root-привилегий, Podman,
  seccomp, cgroups v2 и достаточные права на rootless containers.
- Локально кэшированный Python base image с проверенным **manifest digest**.
  Нельзя подменять digest на tag вроде `latest`. Из образа не выполняются
  RUN-команды, пакетные менеджеры или сетевые запросы.
- Сборка, если её согласовал владелец, производится с `--pull=never` и
  `--network=none` из каталога `supreme-director/campaign180`.
- Результат сборки не получает автоматически доверенный `RepoDigests`.
  Перед аудитом целевого хоста его нужно распространить внутренней
  процедурой supply-chain, закрепить manifest digest и проверить локально
  через `podman image inspect`.

Шаблон сборки (выполняется только оператором в доверенной среде):

```bash
podman build --pull=never --network=none \
  --build-arg BASE_IMAGE='<trusted-cached-python-image>@sha256:<verified-digest>' \
  --file oci-probe/Containerfile --tag osgard-oci-probe:local .
```

`LocalRootlessHostAudit.audit()` требует одновременно флаг в коде
`allow_local_execution=True` и две переменные окружения:

```text
OSGARD_EXPLICIT_LOCAL_SANDBOX=1
OSGARD_EXPLICIT_OCI_HOST_PROBE=1
```

Оператор должен самостоятельно передать точный закреплённый image ref
в `HostProbePolicy`. Отсутствие Seccomp, rootless, cgroup CPU/RAM/PIDs,
private net/pid/user namespace, no-new-privileges или read-only root
приводит к отказу. Образ не получает secrets, token mounts или host mounts.
В качестве результата сохраняется только ограниченная проверяемая
сводка, без клиентских записей.

**В GitHub CI физический запуск Podman не выполняется** — только
fail-closed тесты проверки JSON и запрета запуска без opt-in.
Наличие этого шаблона не разрешает production-исполнение, не
предоставляет публичную/независимую сертификацию и не меняет
релизный gate исходного плана 180 задач.
