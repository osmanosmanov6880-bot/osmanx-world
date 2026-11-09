# TITAN-X11–X15 — исполнение следующих пяти исходных задач

Источник: `supreme-director/originals/DIRECTOR_MASTER_180.md`.
Ветка: `recovery/supreme-director-m187-20261104`. Снимок: `b72a803c482c4592ed00b4783bee2f48d1c18236`.
Никаких работ по TITAN-X16+ не проводилось.

## TITAN-X11 — DevSwarm durable queue и транзакционные leases

**Реализация:** `campaign180/queue.py` теперь записывает все переходы готовности, выдачи, завершения, отмены и восстановления в append-only SQLite `local_job_transitions`. SQLite-триггеры фиксируют события **в одной транзакции** независимо от того, действует Queue, Gateway или Scheduler; задним числом подмена/удаление обычными SQL UPDATE/DELETE запрещены. Добавлены CAS-отмена с требованием tenant и исходного actor и ограниченный список dead letters без тела задания. Оригинальная очередь, дедупликация и счётчик попыток сохранены.

**Подтверждение:** `test_titan_x11_x15_sqlite.py` проверяет запись каждого перехода, отмену, tenant isolation, immutability и получение dead letters. В `pg_devswarm.py` реализована отдельная центральная PostgreSQL-очередь для совместной работы нескольких host-клиентов.

## TITAN-X12 — Fencing и exactly-once-effect через идемпотентность

**Реализация:** `local_job_effects` с уникальными tenant/task_id и tenant/idempotency_key. Финализация результата Queue, Gateway и Scheduler попадает в этот журнал **атомарно через SQLite-триггер** и только при переходе `leased → done`. Состояние `done` и digest результата нельзя изменить через обычный путь. `effect_receipt` и `verify_effect_ledger` обнаруживают missing/phantom receipts. Для PostgreSQL `pg_devswarm.py` завершает работу и создаёт receipt в одной транзакции с fencing и уникальными ограничениями.

**Граница гарантии:** одноразово подтверждена *локальная запись результата*, **не** exactly-once внешнего выполнения/платежа/вызова стороннего API. Для внешнего эффекта нужен отдельный downstream idempotency contract, которого нет в текущих исходниках.

## TITAN-X13 — Восстановление после сбоя worker

**Реализация:** `DurableLocalQueue._renew_tx/renew`, `TransactionalLocalGateway.renew` и `CapacityScheduler.renew`. Heartbeat продлевает lease только под действующим fence, worker_id, доступом tenant и сроком TTL. Обновление lease и resource allocation атомарно; старое значение deadline становится недействительным. При смене прав, истечении lease или уничтожении worker восстановление `recover` освобождает ресурс и запрещает финализацию устаревшего lease. PostgreSQL содержит `recover`, `retry`, `renew` и `cancel`.

## TITAN-X14 — многопроцессный и многосерверный scheduler

**Реализация:** `campaign180/pg_devswarm.py` — общий PostgreSQL 16 backend: глобальная транзакционная fairness-позиция, tenant budgets, `SELECT ... FOR UPDATE SKIP LOCKED`, уникальные task/idem receipts, fencing, CAS heartbeat, истечение/перевыдача lease, retry/cancel/recover, ограничение количества inflight в одном worker. Несколько клиентов подключаются к **общей Postgres БД**, а не к SQLite на общем NFS-диске.

Создание таблиц требует административного вызова `initialize_schema=True`; обычный worker запускается с `initialize_schema=False` и не выполняет DDL. Тест `test_titan_x14_postgres.py` использует disposable PostgreSQL 16 CI. Последнее изменение добавляет конкуренцию отдельных OS-процессов через `ProcessPoolExecutor`.

**Ограничения:** не интегрированы реальные серверы KRAKEN/DevSwarm/Command, production IdP и сетевые worker-адаптеры. Демо с двумя независимыми SQL-сессиями/процессами в CI — достоверный тест центрального состояния, но **не** аттестация production кластера или нескольких физических хостов.

## TITAN-X15 — планирование ресурсов и admission control

**Реализация:** `CapacityScheduler.set_budget` добавляет max_pending и отклоняет уменьшение лимита ниже фактического количества running/queued. SQLite `BEFORE INSERT` trigger защищает длину очереди в каждом маршруте admission. Добавлен `worker_max_inflight` и tenant-scoped `admission_snapshot`. CPU/RAM/disk остаются доверенным `ResourceCost` по capability; значения из тела задания не используются как ресурсная оценка. PostgreSQL реализует эквивалентные tenant/worker budgets и отказы.

**Ограничение:** эти лимиты — контролируемое распределение **запланированных** ресурсов, не физические kernel cgroups для каждого remote worker; соответствующая OS-изоляция проверяется отдельно.

## Тестирование и воспроизведение

```bash
export PYTHONPATH="$PWD/supreme-director/campaign180"
python -m unittest discover -s supreme-director/campaign180/tests -p 'test_titan_x11_x15_sqlite.py' -v
python -m unittest discover -s supreme-director/campaign180/tests -p 'test_scheduler_backup.py' -v
# Только на тестовом Postgres 16 с переменной DEVSWARM_TEST_PG_DSN:
python -m unittest discover -s supreme-director/campaign180/tests -p 'test_titan_x14_postgres.py' -v
```

[Подтверждённый проход Python 3.11 и 3.13 с PostgreSQL 16](https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/42678126792).
[Повтор после добавления теста отдельных процессов](https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/42678373843) — результат уточнять по GitHub Actions; предыдущий зелёный запуск не подменяет этот.

## Миграции и откат

SQLite: добавлены `local_job_transitions`, `local_job_effects`, `scheduler_backpressure`, индексы и триггеры. Миграция существующих локальных `done` jobs формирует только подтверждённые SQLite receipts с известным result_digest; данные без такого digest не объявляются успешно принятыми. Откат требует заранее созданного согласованного SQLite backup и проверки на копии (нельзя просто удалить журналы, сохранив состояния задач).

PostgreSQL: создаются изолированные таблицы `titan_pg_*` в **отдельной тестовой БД**. Удаление этих таблиц допустимо только после сохранения backup/receipt и отмены работающих leases. Ни одна production схема не мигрировалась. Подписанная внешняя задача не запускалась.

## Фактический статус приёмки

Применён код для пяти оригинальных ID. Канонические upstream KRAKEN/DevSwarm/Command по-прежнему не подтверждены владельцем; нет независимого source-owner и security review, release gate сохраняет **NO-GO**. Поэтому исходные X11–X15 имеют связанный локальный код, но **не могут быть названы DONE** и **не считаются независимо принятыми**. X16 и последующие задачи не затрагивались.
