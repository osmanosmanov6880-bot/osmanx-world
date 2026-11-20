# OSMANX Guest Intelligence R38 — resolved Compose, versioned canary, direct DR and ancestry-aware main

Дата: 20 ноября 2026. **Stacked Draft** поверх R37 PR #72. Исходный R37 source: `a9f6cb0b7a9c6af6d005b5a634a1c277b42e8d5f`. **Никакой автоматический merge, deploy, доступ к клиентской БД, снятие STOP или запись гостей не выполняются.**

В отличие от прежних циклов, R38 устраняет четыре конкретных пробела безопасности в существующих исполняемых сценариях; пятый блок — интеграция с API, кабинетом и регрессионными CI.

## Блок 1. Фактическая Docker Compose-конфигурация

`src/guest-r38-compose.mjs`, `scripts/r38-compose-policy.mjs`, `scripts/r38-docker-endpoint.mjs`, `ops/r14-canary.sh`. Проверяется **результат** `docker compose config --format json` после подстановки операторских переменных, а не только исходный YAML. Точная пятёрка сервисов, отсутствие worker/webhook, одна закрытая сеть, один локальный порт `127.0.0.1:3150`, явное `GUEST_WRITES_ENABLED=false`, неизменённый `guest_r14_canary`, приватный том и `no-new-privileges`. Ожидаемый SHA должен совпасть с `build.args.OSMANX_SOURCE_SHA` и с переменной API. Перед вызовом Docker daemon разрешены только заранее известные локальные Unix socket endpoints, не TCP и не SSH-контекст.

Compose JSON может содержать пароли. **Поэтому JSON подаётся прямо в Node через pipe, никогда не печатается и не прикладывается к отчёту**. Размер входа ограничен 256 KiB, результаты содержат только коды отклонений.

## Блок 2. Точная версия исходников в реально работающем canary

`src/guest-r38-build.mjs`, `src/guest-r38-build-route.mjs`, `scripts/r38-source-commit.mjs`, `scripts/r38-local-build-probe.mjs`, `src/server.mjs`, `Dockerfile`, `ops/compose.r14.yml`.

Перед Docker-операциями source SHA определяется **самим инструментом**: либо чистый Git HEAD без незакоммиченных файлов, либо исходный архив с `RELEASE.json` и подтверждённым `SHA256SUMS`. Значение извне не может подменить вычисленный SHA. Точный коммит передаётся как ARG в образ, сохраняется в label/runtime ENV и проверяется локальным `GET /api/industry/v1/health/build` вместе с `guestWritesEnabled:false`. Недостаточно правильного статуса readiness: источник запущенного бинарного артефакта тоже должен совпадать.

Маршрут доступен лишь на сервере с валидным `OSMANX_SOURCE_SHA` в production при выключенных гостевых записях; иначе он возвращает HTTP 503. Содержит только SHA и факт запрета записи, без учётных данных, пилотов или внутренних путей. **Это self-reported release metadata, не подписанная supply-chain provenance и не внешнее свидетельство VPS.**

Операторское управление canary остаётся прежним:

```bash
# На ИЗОЛИРОВАННОМ локальном сервере с готовым Docker и отдельным приватным env:
bash services/industry-api/ops/r14-canary.sh plan /absolute/private/canary.env
# Только после независимого разрешения и ревью:
R14_CANARY_ACK=CONFIRM_ISOLATED_R14_NO_CUSTOMERS \
  bash services/industry-api/ops/r14-canary.sh apply /absolute/private/canary.env
```

Операция apply создаёт тестовые локальные контейнеры и БД — она **не выполнялась этим релизом**. В pipeline CI тестируются только безопасные модели и код.

## Блок 3. Запрет unsafe direct AGE restore

`src/guest-r38-dr-preflight.mjs`, `scripts/r38-dr-preflight.mjs`, обновлённый `ops/restore-dr.sh`. Даже **прямой** запуск старого restore-скрипта теперь не может обойти проверку: URL должен указывать на `127.0.0.1`/`localhost`/`::1` с одноразовым именем `industry_dr_rNN_*`, без URL-параметров. AGE-файл и sidecar SHA256 должны быть ограниченного размера и не быть symlink, ключ должен быть приватным regular file без прав группы/остальных пользователей. Затем проверяется отсутствие индустриальной схемы и вообще любых пользовательских отношений **до** создания расширений и pg_restore; после восстановления — обязательный реальный счётчик индустриальных миграций (11+). Поддерживаются legacy синтетические R19/R22 тесты без доступа к production.

Это не гарантирует физическую offsite-копию, чистоту VPS или независимый rollback; требуется отдельный человек и тест.

## Блок 4. Правильный git ancestry для 24 PR и нового main

`src/guest-r38-mainline.mjs`, `scripts/r38-main-gate.mjs`. Ранее R37 требовал, чтобы Git-дерево `main` *совпадало* с деревом последнего source PR; отдельное изменение сайта могло навсегда создать ложный блокер. С 19 на 20 ноября 2026 `main` действительно получил независимый коммит **OSMANX CINEMA R1** `523a0e15af7f34cf08a68d829f6981be8fc14641`.

Новая проверка через GitHub **только GET**:
- подтверждает точные 24 PR, R37 #72 SHA/tree/parent и пять именованных CI;
- отдельно проверяет все 24 реальных `merged:true`, сохранённые SHA source и последовательность ручного merge;
- сравнивает `SOURCE_SHA...MAIN_SHA`: source должен быть **предком текущего main** (статус ahead/identical + корректный merge-base);
- читает `main` до и после и отказывает при движении HEAD;
- требует свежие пять CI `r37-*` на *текущем* main SHA, завершённые **после** последнего ручного merge;
- позволяет несвязанные коммиты CINEMA на main **без автоматического GO**.

Если организация делает squash или rebase вместо сохранения source commit history, эта стратегия консервативно отдаёт **NO-GO**: такой способ требует отдельной сильной проверки происхождения, а не фальшивой отметки об успехе.

```bash
cd services/industry-api
node scripts/r38-main-gate.mjs --github
```

**Текущий живой блокер:** [PR #47](https://github.com/osmanosmanov6880-bot/osmanx-world/pull/47) открыт в Draft, без независимых reviews. Код не делает его готовым автоматически, не пишет ревью, не объединяет PR.

## Блок 5. Сквозной русский NO-GO кабинет, API и QA

`src/guest-r38-report.mjs`: tenant и SHA-256-связанный отчёт с TTL не более 10 минут, восьмью критическими блокерами, неизменяемым `customerGo:false`. Только два аутентифицированных **MANAGE GET**:

- `GET /api/industry/v1/guest/pilots/:id/r38/readiness`
- `GET /api/industry/v1/guest/pilots/:id/r38/report.csv`

Русский кабинет показывает отдельные блокировки 24 PR, Docker/сборки и восстановления, без кнопок деплоя или снятия STOP. Web process не вызывает инструменты Docker, AGE, GitHub и не читает операторские секреты. CSV защищён от formula-injection. `guestWritesDefault:false` сохраняется в релизном манифесте.

Пять CI заданий: `r38-offline`, `r38-postgres`, `r38-encrypted-dr`, `r38-reproducible`, `r38-release-graph`. Новый набор тестов проверяет публичный порт, неожиданные сервисы, подменённый source SHA, удалённую/непустую БД, образ/runtime source, наследованный SHA-отчёт, чужую компанию, изменения main во время аудита и старые CI. Всегда NO-GO до человеческой приёмки.

## Настоящие внешние условия GO

Нужны независимое ревью и последовательное объединение цепочки PR, доказательство происхождения итогового main, **реальное** staging подтверждение работающего приложения на разрешённом сервере, настоящее offsite AGE восстановление и rollback, действительные договоры/полномочия/правовое основание и отдельный change approval. Ничего из этих внешних условий R38 не считает выполненным.

**R38 Draft. Коммерческий статус NO-GO.**
