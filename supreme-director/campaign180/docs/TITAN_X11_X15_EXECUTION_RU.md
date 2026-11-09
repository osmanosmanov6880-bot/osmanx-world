# TITAN-X11–X15 — исполнение пяти задач исходного плана

Источник требований: `supreme-director/originals/DIRECTOR_MASTER_180.md`.
Снимок кода: `eb243ad520c2711b3b734d46b4980d0767ea27b6`, Draft PR #7.

**Реализованы только X11, X12, X13, X14, X15.** X16 и далее не затрагивались. Оригинальные компоненты KRAKEN/DevSwarm/Command не подключены и канонический SHA upstream отсутствует, поэтому **статус оригинальных задач BLOCKED_UPSTREAM, не DONE**.

## X11 — долговечная очередь и транзакционные leases

В существующем `campaign180/queue.py` добавлен `verify_durability`: в единой SQLite-транзакции проверяет SHA256 тела задачи, имя tenant/idempotency, последнюю запись журнала переходов, lease owner/fence/TTL, соответствие записанных результатов локальному effect receipt и отсутствие orphan receipt. `PRAGMA quick_check` выполняется до сверки. Ошибка целостности отклоняет отчёт; данные других tenants не раскрываются.

## X12 — fencing и exactly-once-effect через идемпотентность

В queue transaction создан `local_effect_outbox` и trigger при фиксации одного `local_job_effects`. Каждое завершённое задание создаёт одну неизменяемую подготовленную запись, повторный `finish` не создаёт её вторично. `campaign180/effect_outbox.py` управляет lease/token/fence, deadline, повторной выдачей после тайм-аута и атомарным подтверждением `ack_sha256`. Поддельный/старый token или fence не принимается. **Exactly-once относится только к записи локального результата/outbox**; выполнение стороннего действия не происходит, для внешней exactly-once доставки требуется идемпотентный downstream.

## X13 — восстановление после сбоя worker

`DurableLocalQueue.recover_worker` обрабатывает только просроченные lease конкретного worker. Реализованы ограничения TTL, возрастающий экспоненциальный backoff, `max_attempts`, dead-letter после исчерпания попыток и атомарные переходы. Здоровые leases не затрагиваются. Старое разрешение не может завершить новое поколение fence.

## X14 — многопроцессный и многосерверный scheduler

Существующий SQLite scheduler дополнен `scheduler_nodes`: `register_node` выдаёт секретный token, поколение и TTL; `heartbeat_node` требует актуальные generation/token и продолжает только активную сессию. `reserve` связывает worker ID с node ID **в той же SQLite транзакции**, не допускает legacy-bypass без токена и ограничивает deadline TTL узла. `renew` требует действующий token/generation и не продлевает lease после node expiry. Есть многопроцессные тесты на общем SQLite файле. **Настоящая координация по нескольким независимым серверам отсутствует**: SQLite на независимых хостах не заменяет PostgreSQL или консенсусный backend.

## X15 — планирование ресурсов и admission control

`CapacityScheduler.admit_with_capacity` проверяет tenant RBAC/scopes, реальную стоимость capability из доверенного server policy, наличие лимитов CPU/RAM/disk и backpressure **до** сохранения задания, затем использует `gateway._admit_tx` в той же `BEGIN IMMEDIATE` транзакции. `verify_capacity_integrity` проверяет, что активные allocations соответствуют lease/worker/fence/deadline и не превышают бюджет. Отсутствующий бюджет и попытка подделать tenant отказываются. CPU/RAM/disk в scheduler — **reservations/admission**, не физические лимиты на уровне ОС.

## Тесты и управление риском

`tests/test_titan_x11_x15.py` — 18 отдельных проверок X11–X15: живые SQLite перезапуски, tamper, повтор и ACK outbox, старый fence, восстановление с backoff, node generation/TTL/token, межпроцессная гонка, cost-admission и orphan allocations.

CI `.github/workflows/titan-original-x11-x15.yml` выполняет эти 18 тестов и существующие queue/gateway/scheduler регрессии на Python 3.11/3.13. Последний green baseline до проверки registered-node bypass: [GitHub Actions #42714569992](https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/42714569992). Для последнего коммита необходимо проверить отдельный CI run.

Rollback: revert коммитов с X11–X15 до слияния. Для совместимости с историческими SQLite данными создание новых таблиц выполнено `IF NOT EXISTS` и backfill outbox через `INSERT OR IGNORE`. Публичных API или production deployment нет.

Критерии оригинальной независимой приёмки **ещё не выполнены**: канонический Git SHA целевых трёх продуктов, security review, работающая распределённая координация, доказательство идемпотентной внешней операции и реальные performance measurements на target topology.

**Итог:** локальный код по пяти конкретным исходным задачам и тесты опубликованы, но исходные пять задач нельзя честно пометить `DONE`. Production и main не изменены.
