# Исполнение первых пяти задач исходного плана — TITAN-X01...X05

**Исходник**: `supreme-director/originals/DIRECTOR_MASTER_180.md`, 17.10.2026.
**Ветка**: `recovery/supreme-director-m187-20261104`.
**Снимок кодовой базы до отчёта**: `32f735e273798ae6a9c5ec9c4e9c7d353ce5d6a4`.
**Scope**: первые **пять** исходных задач TITAN; X06 и далее не менялись.
**Подтверждённый блокер**: `UPSTREAM_REGISTRY.json` не содержит подтверждённого владельцем repo URL, immutable SHA и независимого ревьюера TITAN (KRAKEN/DevSwarm/Command). Доступные репозитории владельца не дают проверяемого права объявить какой-либо из них каноническим TITAN. Не подставляем название по догадке.

## TITAN-X01 — реальный Git baseline

`titan_baseline.py` читает SHA коммита и SHA дерева Git, ветку, нормализованный GitHub remote, количество отслеживаемых файлов, признак грязного worktree, наличие трёх исходных компонент. Проверяет отдельный реестр owner-approved upstream. Подмена URL, SHA и неполная исходная структура отвергаются. Утечка credential-bearing remote запрещена. Код не выполняет git fetch/clone, checkout или изменение репозитория.

**Статус оригинальной задачи:** `BLOCKED_UPSTREAM` — нет подтверждённого канонического upstream и его рабочей копии. Базовый отчёт по имеющемуся Git checkout собирается и проверяется тестами.

## TITAN-X02 — реестр исходников, пакетов и зависимостей

`titan_dependencies.py` считывает реальные отслеживаемые `pyproject.toml`, `package.json`, `requirements*.txt` и lockfiles, сохраняет пути/байты/SHA256, записывает прямые зависимости и обнаруживает floating версии, отсутствие lockfile, потенциально небезопасные динамические requirements и симлинки. Не выдает локальные пакеты за неизвестные upstream-зависимости. В CI формируется JSON с реальным списком.

**Статус:** `BLOCKED_UPSTREAM` — отсутствуют подтверждённые manifests/lockfiles KRAKEN, DevSwarm и Command.

## TITAN-X03 — CODEOWNERS и конфликты изменений

`titan_codeowners.py` применяет реальные правила `.github/CODEOWNERS` по порядку (последнее совпадение), проверяет действительного owner для каждого пути; объединён с существующим `gates.check_change_set` для защиты исходного master, межкомандных правок и секретных путей. Reject traversal/backslashes/невалидные patterns. Проверки конфликта выполняются на реальном diff без ослабления прежнего source-owner gate.

**Статус:** `BLOCKED_UPSTREAM` для оригинальных модулей: локальный CODEOWNERS не является разрешением владельца канонических KRAKEN/DevSwarm/Command и не доказывает branch protection или независимое согласование.

## TITAN-X04 — воспроизводимые сборки и доверенная подпись

`titan_artifacts.py` повторно собирает существующий детерминированный `repro.build_package` и требует побайтового совпадения двух сборок с проверяемым архивом, коммитом и SHA дерева. Затем **Ed25519** подпись проверяется только при совпадении SHA256 DER публичного ключа с **явно переданным доверенным отпечатком**. Неустановленный или другой ключ не проходит. Приватный ключ не сохраняется в репозитории. В CI тестовый ключ создаётся во временном каталоге, удаляется и НИКОГДА не считается production-доверенным.

**Статус:** `BLOCKED_UPSTREAM` для production-сборки: нет канонических исходников/подписи владельца и доверенной внешней цепочки ключей.

## TITAN-X05 — восстановление тестовых зависимостей офлайн

Усилен `offline_deps.restore_into_empty_target`: очистка наследованных PIP-переменных, `--no-index`, `--require-hashes`, изолированный пустой target; после успешного pip установки сверяются точные имена и версии через `importlib.metadata` без импорта пакетов. Новый тест создаёт **валидный локальный wheel**, устанавливает его офлайн и импортирует в отдельном Python-процессе. Подмена hash/отсутствие колеса/небезопасный target отклоняются.

**Статус:** `BLOCKED_UPSTREAM` для отсутствующих тестовых зависимостей KRAKEN/DevSwarm/Command: не предоставлены их исходные requirements и доверенные wheel-файлы. Синтетический wheel не заменяет эти зависимости.

## Приёмка пяти задач

**Точные изменения:** пять целевых модулей/усиление `offline_deps.py`, `tests/test_titan_first_five.py`, `.github/workflows/titan-original-x01-x05.yml`, настоящий журнал X01–X05. Других оригинальных задач не исполняли.

```bash
export PYTHONPATH="$PWD/supreme-director/campaign180"
python -m unittest discover -s supreme-director/campaign180/tests -p 'test_titan_first_five.py' -v
python -m campaign180.titan_baseline --root .
python -m campaign180.titan_dependencies --root .
python -m campaign180.titan_codeowners --root . --path supreme-director/campaign180/campaign180/titan_baseline.py
```

CI: [TITAN Original X01-X05](https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/42673136478). **PASS не отмечен до завершения job.** Проверка подписанного архива и настоящей офлайн-установки выполняется в CI автоматически. Exit codes/logs доступны в GitHub Actions.

**Откат:** revert изменённых коммитов этой ветки или удалить добавленные целевые файлы; серверные данные и схема production не менялись, никаких внешних установок/deploy не выполнялось.

**Независимая приёмка:** ожидает точный канонический repo URL, SHA и доступ к KRAKEN/DevSwarm/Command, source-owner review, подтверждённые test dependencies, release-key provenance и фактический повтор успешных тестов **в целевых модулях**. До этого 0 из первых 5 можно честно назвать независимо завершёнными.
