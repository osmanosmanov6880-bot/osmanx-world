# OSGARD SUPREME DIRECTOR — Wave 14: независимая проверка границ PR

Дата: 2026-11-06. Это только инструмент изоляции и ревью, не релиз.

## Исходная проверка Draft PR #7

- Ссылка: https://github.com/osmanosmanov6880-bot/osmanx-world/pull/7
- Исследованный head: `be92c116cef3b169fa2102b72cf455e120e1d52a`
- Исследованный base `main`: `e7c2cf6d94ef6361620993b65cb55477134bace2`
- Всего 516 изменённых файлов, 205 коммитов.
- Классы: campaign180 — 86; local-kit — 130; m189–m206 — 256; GitHub CI/CODEOWNERS — 20; integration/docs — 20; защищённые оригиналы — 4.

## Реализованные четыре инженерных блока

1. Анализ `git merge-base BASE HEAD` → `HEAD`, а не последнего коммита `HEAD^`.
2. Строгий учёт rename/delete, оригиналов, исходников команд, секретоподобных путей и смешанных направлений.
3. JSON-манифест разделения по областям, SHA-256 списка изменений, фиксированные SHA, явные флаги `merge_authorized: false` и `production_authorized: false`.
4. Изолированный CI с правами только `contents: read` и локальными unittest. Артефакт сохраняется при отказе gate.

## Стратегия разделения

- PR A: только `.github/release-audit/**` и один workflow. Создан от `main`, независимо от PR #7.
- PR B: отдельная проверка `campaign180` после переноса только подтверждённых зависимостей.
- PR C: `local-kit` и его исторические зависимости — после сверки источников.
- PR D: `m189`–`m206` маленькими независимыми наборами с подтверждёнными зависимостями.
- HOLD: четыре оригинала (`supreme-director/originals` и `supreme-director/recovery`) и любые неутверждённые upstream-исходники.

## Воспроизведение

```sh
python3 -m unittest discover -s .github/release-audit/tests -p 'test_*.py' -v
python3 .github/release-audit/analyze.py --repo . --base-sha "$BASE_SHA" --head-sha "$HEAD_SHA" --output /tmp/osgard-pr-boundary.json --enforce
```

Если в PR несколько направлений или защищённые изменения, gate возвращает NO-GO. Зелёный локальный gate не является независимым код-ревью и не даёт права на merge/deploy. Текущая независимая приёмка исходных 180 задач: **0/180**.

Ни `main`, ни production, ни исходный Draft PR #7 этим проходом не меняются.
