# OSGARD SUPREME DIRECTOR · восстановление M187

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

Шесть команд имеют 30 задач каждая: [TITAN (#1)](https://github.com/osmanosmanov6880-bot/osmanx-world/issues/1), [NEXUS (#2)](https://github.com/osmanosmanov6880-bot/osmanx-world/issues/2), [COMMERCE (#3)](https://github.com/osmanosmanov6880-bot/osmanx-world/issues/3), [EXPERIENCE (#4)](https://github.com/osmanosmanov6880-bot/osmanx-world/issues/4), [GENESIS (#5)](https://github.com/osmanosmanov6880-bot/osmanx-world/issues/5), [ORBITAL (#6)](https://github.com/osmanosmanov6880-bot/osmanx-world/issues/6).

## Не опубликовано в GitHub в этой партии

Полный бинарный ZIP M187 ~199 МиБ (включая историю и вложенные архивы) **не передан в git**, потому что прямой канал загрузки из файловой среды недоступен. Этот ZIP остаётся доступным как отдельный файловый артефакт текущей беседы. Исходные файлы M186/M187 локально распакованы и тест `test_m187.py` пройден (23/23), но их код нельзя считать выгруженным в GitHub, пока он не находится в дереве репозитория.

Оригинальные M180/M181 Git commits отсутствуют в проверенном локальном M186 bundle. Истинные upstream шести систем не верифицированы; независимая приёмка исходных задач — **0/180**, производственный релиз — **NO-GO**.

## Документация и режим работы

- [Журнал](docs/PROGRESS_JOURNAL_RU.md)
- [Маршрут восстановления и критерии приёмки](docs/RECOVERY_ROADMAP_RU.md)
- [Журнал ограничений](docs/SOURCE_GAPS_RU.md)

Все внешние действия с риском (production, платежи, отправки, токены, реальное управление оборудованием) требуют отдельной авторизации владельца с operation ID. Данные из локального M187 — исключительно модель, не результат интеграции всех шести реальных продуктов.
