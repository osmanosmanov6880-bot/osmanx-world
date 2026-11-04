# OSGARD SUPREME DIRECTOR · восстановление M187 → M190

**Дата:** 2026-11-04 · **Статус:** RECOVERY IN PROGRESS / PRODUCTION NO-GO

Этот каталог хранит оригинальный план на 180 инженерных пакетов и **проверяемую часть** реконструкции M187. Реконструкция — не идентична исходным архивам M180/M181. Ветка `recovery/supreme-director-m187-20261104` не должна автоматически развёртываться вместо osmanx.world.

## Быстрый старт (русский интерфейс)

Из корня репозитория:

```bash
python3 supreme-director/scripts/validate_plan.py
python3 -m unittest discover -s supreme-director/tests -p 'test_*.py' -v
python3 -m http.server 8080
```

Откройте `http://localhost:8080/supreme-director/web/`. Сервер нужен, так как браузер ограничивает `fetch` при открытии HTML через `file://`.

Панель показывает все 180 задач, фильтры, зависимости, локальные записи, а также экспорт в JSON. Записи браузера **не синхронизируются** с GitHub, не служат актом приёмки и не отправляются на сервер. Оригинальные 180 задач и исходные SHA остаются неизменными. Чтобы видеть последние события, открывайте GitHub Issues и журнал.

## Что опубликовано в GitHub

- `originals/DIRECTOR_MASTER_180.md` — исходный пользовательский документ (SHA-256: `71fdda8231e1cb627a36fa683eaab1c28e4bdff2da9c95e0e6f6df83624a4b6c`).
- `recovery/ORIGINAL_180_TASKS.json` — 180 оригинальных ID, названий, команд и 294 явных ссылок зависимостей.
- `recovery/M187_DEPENDENCY_WAVES.json` — восстановленный порядок и статус блокировок.
- `recovery/M187_RECOVERY_REPORT.json` — ограничения текущего состояния.
- `web/` — самостоятельная визуальная рабочая панель на русском.
- `scripts/validate_plan.py`, `tests/` и CI — проверка исходного плана.
- `local-kit/` — 130 переносимых текстовых файлов M182–M187: реальные модули, локальные интерфейсы, оригинальные тесты и скрипты без тяжёлых бинарных архивов.
- `scripts/verify_source_transfer.py` — SHA-256 каждого из 129 файлов по манифесту + проверка точного состава каталога.
- [Отчёт M188](docs/M188_SOURCE_TRANSFER_RU.md) — результаты и доказательства двух успешных CI jobs.

Шесть команд имеют 30 задач каждая: [TITAN (#1)](https://github.com/osmanosmanov6880-bot/osmanx-world/issues/1), [NEXUS (#2)](https://github.com/osmanosmanov6880-bot/osmanx-world/issues/2), [COMMERCE (#3)](https://github.com/osmanosmanov6880-bot/osmanx-world/issues/3), [EXPERIENCE (#4)](https://github.com/osmanosmanov6880-bot/osmanx-world/issues/4), [GENESIS (#5)](https://github.com/osmanosmanov6880-bot/osmanx-world/issues/5), [ORBITAL (#6)](https://github.com/osmanosmanov6880-bot/osmanx-world/issues/6).

## Ограничения по-прежнему отсутствующих исходников

Полный бинарный ZIP M187 ~199 МиБ (включая историю и вложенные архивы) **не передан в git**, потому что прямой канал загрузки из файловой среды недоступен. Этот ZIP остаётся доступным как отдельный файловый артефакт текущей беседы. **Код текстовой части M182–M187 уже опубликован в `local-kit/` (130 файлов)**. Исходный полный ZIP содержит также не опубликованные бинарные Git-bundle, вложенные ZIP и снимки экранов. Для облегчённого комплекта: **22/22 применимых тестов PASS**; отсутствующий исторический bundle тест исключён явно. GitHub Actions [#41844376779](https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/41844376779) подтвердил обе проверки.

Оригинальные M180/M181 Git commits отсутствуют в проверенном локальном M186 bundle. Истинные upstream шести систем не верифицированы; независимая приёмка исходных задач — **0/180**, производственный релиз — **NO-GO**.

## Документация и режим работы

- [Журнал](docs/PROGRESS_JOURNAL_RU.md)
- [Маршрут восстановления и критерии приёмки](docs/RECOVERY_ROADMAP_RU.md)
- [Журнал ограничений](docs/SOURCE_GAPS_RU.md)
- [M188 — проверенная публикация исходников](docs/M188_SOURCE_TRANSFER_RU.md)
- [M188 — публичная проверка возможных upstream](docs/M188_PUBLIC_UPSTREAM_DISCOVERY_RU.md)

Все внешние действия с риском (production, платежи, отправки, токены, реальное управление оборудованием) требуют отдельной авторизации владельца с operation ID. Данные из локального M187 — исключительно модель, не результат интеграции всех шести реальных продуктов.

## Запуск восстановленного исходного кода M182–M187

Из корня репозитория:

```bash
python3 supreme-director/scripts/verify_source_transfer.py
python3 supreme-director/local-kit/scripts/verify_source_only.py
cd supreme-director/local-kit
python3 -m osgard_m187 restore-plan
python3 -m osgard_m187 plan-waves
```

Для локального запуска приложения установите Python 3.13 и `cryptography==46.0.4` из `local-kit/requirements-m185.txt`, затем используйте `START_OSGARD_M187_WINDOWS.cmd` или `START_OSGARD_M187_LINUX_MAC.sh` **из папки `local-kit`**. Только синтетические данные и loopback. Прежде чем запускать полное тестирование с архивными фикстурами, потребуется полный исторический M187 ZIP: в исходном комплекте Git его бинарные fixtures не включены.

Дополнительный изолированный smoke-тест M186 (9 контрактов и принудительный отказ на пятом, **без** реальных интеграций):

```bash
python3 supreme-director/scripts/smoke_m186.py
```

Проверен GitHub Actions [#41845642452](https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/41845642452): обе jobs успешны.


## M189 — подписанный контроль свидетельств и блокировка ложных релизов

Реализован [M189 Admission Gate](m189/admission.py) для 180 задач и шести команд. Это read-only инструмент; ни одну из команд из представленных тестовых отчётов он **не выполняет**. Он проверяет оригинальные SHA-256, закреплённые Git commit/tree, локальный Git checkout и origin, подписи Ed25519 владельца и проверяющего, SHA-256 файлов и журналов, пять групп проверок, план отката и связи между задачами. Для нового компонента **19 локальных синтетических тестов PASS**.

Доверенные ключи и реальные baseline отсутствуют намеренно: [реестр исходников](m189/data/M189_UPSTREAMS.json), [проверяющие](m189/data/M189_TRUST_KEYS.json), [заявки](m189/data/M189_SUBMISSIONS.json). При их отсутствии программа честно возвращает **180 BLOCKED_UPSTREAM, 0 независимо принятых и NO_GO**.

Полный разбор и команды: [M189 — инженерный допуск](docs/M189_ENGINEERING_GATE_RU.md). Дополнительная проверка включена в GitHub Actions. Нельзя ставить `VERIFIED` только на основании локальной подписи: нужны владелец настоящего продукта, независимая продуктовая приёмка и release authorization.

## M190 — локальный журнал проверок, независимые anchor и восстановление цепочки

Новый модуль [m190/](m190/) дополняет M189: SQLite с транзакционным append-only журналом, хеш-цепочкой SHA-256, проверкой последнего известного head перед записью, повторяемым импортом отчёта M189 и экспортом журнала. Не меняет статус оригинальных задач и не запускает внешние системы.

Проверки: **33 unit/negative теста и отдельный smoke M189 → M190 локально PASS**. GitHub Actions содержит отдельную job `m190-ledger`; актуальный результат см. в разделе Actions PR #7. Оригинальные M180/M181 отсутствуют, **0/180 original task acceptance, production NO_GO**.

[Инструкция M190](m190/README_RU.md) · [Инженерный отчёт](docs/M190_ENGINEERING_JOURNAL_RU.md)

Из корня репозитория:

```bash
python3 supreme-director/m190/verify_source.py
PYTHONPATH=supreme-director python3 -m unittest discover -s supreme-director/m190/tests -p 'test_*.py' -v
PYTHONPATH=supreme-director python3 supreme-director/m190/smoke.py
```

## M189 dependency hardening (после M190)

В `m189/admission.py` исправлена транзитивная блокировка: задача не остаётся готовой к внешней проверке, если хотя бы один её предок по цепочке зависимостей заблокирован. Добавлены два регрессионных теста. В актуальном наборе **21 тест M189** (19 исходных + 2 новых), независимо принятых продуктовых задач по-прежнему **0/180**.


## M193 — рабочая CRM и русский интерфейс

Новый код: [`m193/`](m193/). Русская документация: [`docs/M193_CRM_STUDIO_RU.md`](docs/M193_CRM_STUDIO_RU.md).

Реализовано: изменение клиентов и сделок с версиями, этапы воронки,
контакты и напоминания, изоляция организаций, локальный интерфейс на
`http://127.0.0.1:8713/studio/`. Используется реальная локальная SQLite.
Проверка CI: [M193 GitHub Actions](https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/41918050796)
(Python 3.11/3.13, 40 тестов M193 + 46 регрессионных тестов M192).

```bash
# From supreme-director/; initialize only a NEW local database:
PYTHONPATH=m192:m193 python3 -m osgard_m193 init --db ./m193-local.sqlite --tenant "Local Business" --actor owner
PYTHONPATH=m192:m193 python3 -m osgard_m193 serve --db ./m193-local.sqlite --port 8713
```

**Важно:** пока нет независимой продуктовой приёмки всех 180 заданий;
production **NO-GO**. Интерфейс ещё не проверен визуально на реальном устройстве.

## M194 — операционный центр CRM и массовые операции

Новый исполняемый код: [`m194/`](m194/). Модуль развивает реальные локальные данные M192→M193, не заменяет оригинальные M180/M181. Добавлены CSV импорт с предварительным SHA-256 и атомарной записью, owner-only экспорт с защитой формул, очередь и массовое завершение повторных контактов, редактирование сроков и реальные метрики воронки. Исправлена выдача русских переводов через `/studio/ru.json`.

Локально: **121/121 тестов PASS** (M194: 35, M193: 40, M192: 46). Визуальный браузерный тест остаётся непроверенным из-за ограничения среды. Подробности и запуск: [M194 README](m194/README.md), [инженерный журнал](m194/docs/M194_ENGINEERING_JOURNAL_RU.md).

```bash
# Из каталога supreme-director/ после резервного копирования ваших данных:
PYTHONPATH=m192:m193:m194 python3 -m osgard_m194 init --db ./m194-local.sqlite --tenant "Local Business" --actor owner
PYTHONPATH=m192:m193:m194 python3 -m osgard_m194 serve --db ./m194-local.sqlite --port 8714
```

Сервер доступен **только на localhost** по `http://127.0.0.1:8714/studio/`. Инструкция `init` создаёт новую базу и откажет при существующей. Полное выполнение исходных 180 инженерных задач и production готовность не заявляются.


## M197 — карточка проекта, документы и обязательства

Новый локальный модуль [M197](m197/README.md) расширяет M196: отдельная русская карточка `http://127.0.0.1:8717/projects/`, версии файлов с SHA-256, клиентские обязательства и контроль сроков. Полные исходники и проверки: [m197/](m197/), [журнал M197](m197/docs/M197_ENGINEERING_JOURNAL_RU.md). 
Источник истины остаётся SQLite; публичная публикация и автоматическая независимая приёмка **не разрешены**. Исторические 180 задач: **0/180 независимо приняты**.
