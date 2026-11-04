# OSGARD SUPREME DIRECTOR · восстановление M187 → M188

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
