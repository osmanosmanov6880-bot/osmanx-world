# OSGARD SUPREME DIRECTOR — Wave 14

Дата: 9 ноября 2026. Рабочая ветка `recovery/supreme-director-m187-20261104`, Draft PR #7. Изменения локального инженерного контура. `main`, production и канонические upstream не менялись.

## 1. HMAC-SHA256 разрешение на локальное вычисление

Файл `campaign180/local_permits.py`. `LocalPermitAuthority` выпускает versioned разрешения с проверкой `TaskEnvelope`: tenant, actor, task UUID, SHA-256 задачи, capability `sandbox.evaluate`, scopes, допустимые единицы квоты, время и случайный nonce. TTL не превышает 120 секунд. Подпись покрывает весь канонический JSON. Любая подмена данных, повторное связывание с другой задачей или попытка использования после истечения TTL отклоняется.

Ключ подписания передаётся только доверенным Python-кодом и **не сохраняется в SQLite**. Отсутствует внешний IdP и hardware-backed signing; HMAC является симметричным. Проверка не доказывает независимость подписанта.

## 2. Транзакционный SQLite исполнитель

Файл `campaign180/fenced_compute.py`. `LocalFencedExecutor` объединяет подписанное одноразовое разрешение, существующую `TenantQuotaLedger` и фактический вызов `run_allowlisted_task`.

`BEGIN IMMEDIATE` атомарно вставляет квотный lease и запись о занятом nonce/task/idempotency key. Повтор этой тройки блокируется. Исполнение поддерживает **только четыре фиксированные side-effect-free вычислительные операции**, а не произвольный Python, shell, запись на диск, сетевой доступ или внешние действия. По завершении квота и receipt изменяются в одной SQLite-транзакции. При отказе резерв возвращается, но разрешение не переиспользуется. При аварийном завершении процесс не оставляет право на повторный запуск: истечение lease освобождает квоту, а consumed nonce остаётся в журнале.

Это exactly-once **учёт местного вычисления**, а не гарантия exactly-once для внешних бизнес-операций. Распределённых узлов и production workers нет.

## 3. Верификация и внешнее свидетельство состояния

Файл `campaign180/compute_evidence.py`. Проверяет в одной read-only SQLite snapshot-транзакции, что сумма held/spent для tenant совпадает с состояниями lease, а каждая execution receipt соответствует своему lease. Создаёт HMAC-SHA256 checkpoint с числом записей и хешем состояния без клиентских payload, секретов, одноразовых токенов или полных idempotency-ключей.

Доступна `write_once` для создания файла только с O_EXCL (без перезаписи), правами 0600 и fsync. `verify_file` требует канонический JSON, корректную подпись и совпадение с текущим состоянием. Изменение базы после подписи обнаруживается, если контрольный файл сохранён и ключ подписи не скомпрометирован. Этот механизм **не является независимым публично проверяемым аудитом**.

## 4. Rootless Podman — усиление существующего модуля

Модули `campaign180/sandbox.py` и `campaign180/oci_gate.py`: добавлены приватные `--userns`/`--cgroupns`, `--no-hosts`, отключение лог-драйвера и ограниченная очистка по уникальному имени fenced-контейнера при тайм-ауте.

`LocalOciGate` проверяет минимальные защитные параметры запуска, rootless/seccomp/cgroup v2, присутствие закреплённого sha256-образа в локальном OCI-cache через `image inspect`. Никаких pull/download или host mounts, HTTPS-запросов и произвольных команд пользователя. Реальный запуск требует явно установленного `allow_local_execution=True` плюс `OSGARD_EXPLICIT_LOCAL_SANDBOX=1`.

**Важно:** в GitHub CI план и обработка Podman API проверяются с mocks. Реальный Podman на отдельном non-root Linux host пока не прошёл независимое испытание. Поэтому здесь НЕ заявляется полноценная физическая изоляция, сертификация seccomp или готовность к production.

## 5. Настоящий e2e, 18 негативных/позитивных тестов и CI

`tests/test_wave14_signed_compute_oci.py` проверяет: поддельные подписи и scopes, cross-tenant, TTL, replay, конкурентные запросы одной и той же задачи, возврат квоты при тайм-ауте, reclaim после simulated crash, неизменность квот другой организации, несовпадения receipt/lease, повреждение и подмену checkpoint и отказ при отсутствии нужных OCI-флагов.

`campaign180/wave14_acceptance.py` реально запускает `python -I -S -B` для безопасной арифметической и SHA-256 операции в subprocess, проводит бюджетные транзакции и подписывает write-once checkpoint с синтетическими данными. Он не исполняет внешних действий.

В `.github/workflows/supreme-director-wave14-local-execution.yml` настроена независимая проверка на Linux Python 3.11/3.13. Обе матрицы успешно прошли: [GitHub Actions run #42554635337](https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/42554635337). Проверка также запускает предыдущие `test_sandbox.py` и отдельно утверждает, что релизный gate исходных 180 задач остаётся NO-GO.

```bash
export PYTHONPATH="$PWD/supreme-director/campaign180"
python -m unittest discover -s supreme-director/campaign180/tests -p 'test_wave14_*.py' -v
python -m unittest discover -s supreme-director/campaign180/tests -p 'test_sandbox.py' -v
python -m campaign180.wave14_acceptance
```

## Разделение локальных результатов и независимой приёмки

Защищённые исходные файлы всего Draft PR #7 требуют owner review по `check_change_set`; проверка релизного соответствия исходному плану остаётся красной и **не отключена**. Точный счётчик оригинальных ID: **36 со связанным локальным кодом, 136 без доказательства, 4 SkillCred вне scope, 4 Noor без исходников, 0/180 независимо принято**.

Нет подтверждённого production deploy, распределённого fencing, физической проверки rootless-изоляции на целевом сервере и доказанного интеграционного запуска исходных шести продуктов. Release: NO-GO.
