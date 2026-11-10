# Wave 15 — OSGARD SUPREME DIRECTOR

Дата: 9 ноября 2026. Draft PR #7, рабочая ветка `recovery/supreme-director-m187-20261104`. `main` и production не менялись.

## 1. Неизменяемый журнал задач — TITAN-X12/X27

Модуль `campaign180/compute_events.py` содержит tenant-scoped, упорядоченную SHA-256 цепочку `reserved → completed/failed/expired`. Она записывается в **той же SQLite BEGIN IMMEDIATE транзакции**, что и изменение квоты, lease и receipt. `verify` проверяет последовательность, SHA-256, отсутствие двойной резервации и соответствие текущим receipt. В журнале нет исходных idempotency-ключей, secret или клиентских данных, только их криптографические обязательства и квотные метаданные.

`TenantQuotaLedger` теперь не имеет права погасить quota по фиксированному permit через общий `reclaim_expired` без обновления receipt и события. Для этого требуется `LocalFencedExecutor.reclaim` с одной транзакцией. Старые БД с receipt без журналов не мигрируются автоматически, поскольку восстановление истории без доказательств было бы небезопасным.

## 2. Подписанный снимок v2 — TITAN-X27

`compute_evidence.py` подписывает HMAC-SHA256 **состояние квот, receipts и голову/длину event-chain**. Версия изменилась на `osgard.local-compute-checkpoint/2`; старые checkpoint не подменяются новыми. Проверка старого файла после изменения состояния отказывает, write-once файл создаётся с O_EXCL и 0600. Это локальная симметричная подпись, а не публичное независимое свидетельство.

## 3. Неизменяемый вычислитель — TITAN-X09/X10

`sealed_worker.py` проверяет точный SHA-256 файла `bounded_worker.py`, запрещает изменённый файл и симлинк, затем создаёт Linux `memfd` и применяет `F_SEAL_WRITE/GROW/SHRINK/SEAL`. `sandbox_runtime.py` запускает `python -I -S -B /proc/self/fd/...` из этого запечатанного файла с `pass_fds`; при тайм-ауте ограничивает группу процессов. CPU/RAM/fd/FSIZE остаются ограниченными POSIX RLIMIT. Здесь **нет произвольного пользовательского Python** и не заявляется полноценный контейнер ОС.

## 4. Физический rootless OCI host probe (запрещён по умолчанию)

`oci_host_attestation.py` вместе с фиксированным `oci_probe_payload.py` проверяет на отдельном non-root Linux-хосте: приватные net/pid/user namespaces, Seccomp=2, NoNewPrivs=1, отсутствие эффективных capabilities, read-only root и finite cgroups v2 CPU/RAM/PIDs. Используется заранее проверенный, кэшированный digest-pinned образ, `--pull=never`, `--network=none`. Требуются **оба** окружения `OSGARD_EXPLICIT_LOCAL_SANDBOX=1` и `OSGARD_EXPLICIT_OCI_HOST_PROBE=1` плюс явное `allow_local_execution=True`.

Инструкция: [офлайн-проверка OCI](../oci-probe/README_RU.md). CI проверяет только pure evaluator и запрет вызова без opt-in. **На целевом хосте фактическая проверка ещё не выполнялась.**

## 5. Многопроцессная и негативная CI-приёмка — TITAN-X26/X29

`test_wave15_compute_integrity.py` — 17 тестов на реальный memfd, отказ подменённому Python-файлу, попытку изменить kernel-sealed fd, конкуренцию **трёх отдельных процессов** за одно разрешение, tenant binding, replay, expiry и невозможность обхода квоты. Тесты подмены цепочки SQL и receipt, обновлённого HMAC и недопустимых kernel-параметров OCI исполняются на синтетических данных. `wave15_acceptance.py` проводит безопасное e2e выполнение и возвращает только технический JSON.

Отдельный workflow `supreme-director-wave15-local-integrity.yml` тестирует Python 3.11/3.13, регрессию Wave13/14, e2e evidence и неизменность оригинального release NO-GO.

```bash
export PYTHONPATH="$PWD/supreme-director/campaign180"
python -m unittest discover -s supreme-director/campaign180/tests -p 'test_wave15_*.py' -v
python -m campaign180.wave15_acceptance
```

## Ограничения приёмки

До подтверждённого GitHub Actions PASS Wave15 нельзя считать протестированным. Целевая физическая защита rootless OCI не проверена. Оригинальные шесть upstream не объединены, protected-source policy не отменена. **36 связанных локальных ID, 136 без доказательства, 8 на удержании, 0/180 независимо принято; production gate = NO-GO.**
