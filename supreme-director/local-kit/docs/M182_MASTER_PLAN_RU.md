# OSGARD DIRECTOR — M182 / план до независимой приёмки

**Дата:** 27 октября 2026 года. **Статус:** M182 LOCAL TOOLING PASS / M181 ORIGINS BLOCKED / PRODUCTION NO-GO.

## 0. О чём говорят исходные цифры

По отчёту пользователя: M180 имел 180 задач и 294 зависимости; M181 — 176/176 локальных инженерных тестов, 3495 исходных файлов, 28 межкомандных конфликтов (17 P0, 11 P1), 9 API-контрактов, 6 команд. Исходный ZIP M181 заявлен SHA-256 `c6d0ff3ff9caa435e6928244ab70ecee8156747306ac3174faca82702be2969a` и локальным commit `ff5e6de7e9614add995d11a7330fc2f13d2c1206`.

**Ограничение:** текущий M182 пакет не содержит исходного ZIP M181, поэтому эти прежние значения не подтверждены новым прогоном. Доказательство 176/176 из M181 не перенесено в новую матрицу тестов. Выполнена самостоятельная тестовая матрица *нового* инструмента M182; её актуальный протокол находится в `evidence/M182_UNITTEST_FINAL.log`.

В Библиотеке есть отдельные материалы `OSGARD SUPREME DIRECTOR C9` с теми же 180 задачами и 294 зависимостями, но прямой SHA/Git связи C9↔M181 пока нет. Подмена исходного board при отсутствии такой связи запрещена.

## Блок A — доказать происхождение шести исходных веток: 12 задач

**Цель:** для каждой из шести команд получить два независимых результата: (1) подтверждённый canonical upstream Git (repo, точный 40-char SHA, владелец, ветка, approval); (2) SHA-проверенный оригинальный M181 ZIP + crosswalk конкретной задачи к оригинальному TASK_BOARD.

- Сохранить оригинальные M180 и M181 ZIP без изменений. SHA считается локально по целому файлу и фиксируется в read-only receipt.
- Только после совпадения pin — безопасный просмотр ZIP без извлечения. Контроль ZIP paths, CRC, объёма, symlink/device и дубликатов.
- Не переносить HEAD из игры `osgard-world` или фронтенда `osgardos` на DIRECTOR-команды без владельца/подписанного подтверждения назначения.
- Сравнивать canonical Git HEAD каждого продукта с исходным snapshot и документировать любой divergence.

**Gate A / выход:** 6/6 оригинальных upstream SHA и owner approval; 180/180 исходных ID, 294/294 dependency edges, подтверждённое побайтовое происхождение source ZIP. Сейчас gate не пройден.

## Блок B — security, contracts и контроль конфликтов: 48 задач

**По 8 задач на каждую команду.** IAM/SSO/RBAC, secrets, SBOM/licenses, sandbox/tenant boundary, API schema, migration/rollback, fail-closed evidence/negative tests, CODEOWNERS security review.

### 28 конфликтов: разрешение без потери версий

1. Получить 28 оригинальных `path`, два SHA каждой конфликтующей версии и associated base commit. Пустые пути из текущего шаблона не являются результатом аудита.
2. Для каждого из **17 P0**: поставить независимое CODEOWNERS+security review; запрет merge до negative test, contract compatibility и запрета silent override.
3. Для **11 P1**: отдельный compatibility/evidence review; нельзя считать «неопасно» только из приоритета.
4. Для `KEEP_LEFT`/`KEEP_RIGHT`/`MANUAL_MERGE` требовать объяснение, новые точные SHA, ID PR, CI прогоны на exact head и разные author/reviewer.
5. Не импортировать 18 кэшированных файлов, локальную SQLite, два STYLO шрифта без отдельного provenance/license review.
6. Не удалять исторические доказательства; новые версии review-отчётов публиковать отдельными неизменяемыми receipts.

### Девять API-контрактов

Для каждого: producer, consumer, canonical schema (контрольная сумма), contract test (positive/negative), backward compatibility, rollback, staging E2E и external reviewer. Только полная матрица 9/9 является *кандидатом* к независимой приёмке, а не автоматическим GO.

**Gate B:** 28/28 оригинальных конфликтов с доказательствами и 9/9 contract suites на SHA-pinned builds, security reviewer не является автором.

## Блок C — 90 прикладных интеграционных задач

По 15 задач на каждую команду. Подробные рабочие задания из данного этапа находятся в `docs/HANDOFF_*_30_RU.md` и в `docs/M182_WORKPLAN_180_PROPOSED.json`. Ни одна карточка не присваивает себе исходный M181 ID, статус ACCEPTED или разрешение на production.

- **TITAN / KRAKEN:** sandbox, worker leases, tenant isolation, queue, durable audits, cross-service job API.
- **NEXUS / ÆTHERION:** agent/tool scopes, model provider failures, privacy, budget, prompt injection boundary, tool audits.
- **COMMERCE:** sandbox payments, refunds, idempotency, webhooks, ledger reconciliation, entitlements.
- **HUMAN EXPERIENCE:** accessible user journey, permissions, consent, localization, responsive/device tests.
- **GENESIS MEDIA:** content provenance, media processing, licensing, CDN, secure upload and revoke.
- **ORBITAL:** reproducible research, immutable ledger evidence, voting/replay resilience, independent decisions.

**Gate C:** 90/90 original mapped source PRs integrated to *staging only*, each with passing source-specific CI, cross-contract E2E, rollback test and independent review.

## Блок D — испытания, готовность и release: 30 задач

По 5 задач на команду: SHA-specific staging E2E, independent threat/security review, restore/rollback rehearsal, measured performance/on-call, separate owner signoff. Все результаты привязываются к commit SHA и неизменяемому artifact digest.

**Gate D:** все 180 оригинальных задач получили независимую приёмку, 28 конфликтов и девять контрактов закрыты, реальный staging/prod-equivalent rollback проверен, человеческое product/security решение подписано. **M182 не выполнял Gate D и не ставит production GO.**

## Применение нового программного контура

```bash
python3 -m unittest discover -s tests -v
python3 -m osgard_m182 bootstrap --dir templates
python3 -m osgard_m182 audit --archive /path/to/original/M181.zip \
  --board /path/to/original/TASK_BOARD.json \
  --conflicts /path/to/original/conflicts.json \
  --contracts /path/to/original/contracts.json \
  --upstreams /path/to/original/upstreams.json \
  --json-out evidence/NEW_AUDIT.json --md-out evidence/NEW_AUDIT.md
```

`audit` возвращает exit code `2` при ожидаемом NO-GO. Его нельзя превращать в PASS через `|| true`. Для бинарной сверки оригинальных M180/M181 есть `python3 -m osgard_m182 compare --help`; оба SHA обязательны. Успешный diff не открывает gate release.

## Документирование прогресса

Основные опорные файлы:

- `docs/PROGRESS_JOURNAL_RU.md` — события и принятые инженерные решения M182;
- `docs/SOURCE_PROVENANCE_RECONCILIATION.json` — проверенные по GitHub наблюдения, без назначения командам;
- `evidence/ADMISSION_RESULT.json` + `.md` — машинный и читаемый отказной аудит;
- `evidence/M182_UNITTEST_FINAL.log` — настоящий локальный тестовый прогон M182;
- `docs/M182_WORKPLAN_180_PROPOSED.json` — **новый** план задач, не оригинальный TASK_BOARD;
- `SHA256SUMS.txt` — проверяемый список всех файлов поставки;
- `evidence/M182_SOURCE_GIT.bundle` — отдельная локальная история только инструмента M182 (не M180→M181).

## Решение

**M182 local tooling может быть передан для независимого code review.** Продукты шести команд, оригинальный M181 архив, подлинные upstream и 28 фактических конфликтующих путей по-прежнему требуют подтверждения. Результат **PRODUCTION NO-GO**.
