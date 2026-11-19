# OSMANX Guest Intelligence R37 — реальные эксплуатационные проверки, без production

Дата: 20 ноября 2026. Основа: Draft R36 PR #71, pinned commit `8da6192969ec8a5d1d1523a6a605ba04d5299718`. R37 создаётся отдельным **stacked Draft**, не меняет `main`, VPS, DNS, эксплуатационные пароли и реальные гостевые записи.

## Пять реализованных блоков

### 1. R14 canary: полноценный preflight прав секретов и loopback-топологии

`src/guest-r37-canary-guard.mjs`, `scripts/r37-canary-preflight.mjs`, исправленный `ops/r14-canary.sh`. Перед **любой** Docker-операцией проверяется: приватный env-файл действительно regular (не symlink), не лежит в Git checkout, принадлежит текущему оператору, не доступен группе/остальным пользователям (chmod 600 или строже), ограничен 32 KiB. Содержимое env-файла не читается в предохранительном слое, в отчёте нет пути или паролей. Compose должен сохранить фиксированный проект `osmanx-guest-r14-canary`, приватную сеть/том, API на `127.0.0.1:3150`, `GUEST_WRITES_ENABLED: "false"` и отсутствие публичных портов/дополнительных worker/webhook сервисов.

Пример **только read-only предохранительной проверки** из разрешённого окружения:

```bash
cd services/industry-api
node scripts/r37-canary-preflight.mjs /absolute/secure/operator.env /absolute/checkout/services/industry-api/ops/compose.r14.yml
```

Этот шаг не разворачивает canary. Реальный R14 `apply` остаётся отдельной ручной операцией с существующим подтверждением `R14_CANARY_ACK`.

### 2. Локальное AGE/PostgreSQL восстановление: реальная база до и после

`src/guest-r37-dr-verified.mjs`, `scripts/r37-local-dr.mjs`. Только после явного операционного допуска `GUEST_R37_DR_ACK=RESTORE_DISPOSABLE_LOCAL_ONLY` и валидного R36-плана проверяется точная **локальная** БД `industry_dr_r36_*` на `127.0.0.1`/`localhost`/`::1`, без параметров URL. В отдельном настоящем SQL-чтении (не только по имени URL) проверяются `current_database()`, адрес и порт PostgreSQL, режим read/write, запуск сервера, отсутствие `industry` и иных пользовательских таблиц. Наличие какой-либо ранее восстановленной схемы запрещает запуск. После существующего `ops/restore-dr.sh` проверяются появление `industry`, ненулевое количество отношений, и наличие 11+ миграций.

```bash
cd services/industry-api
# Значения ниже — placeholders, а не действующие учётные данные.
export DR_RESTORE_DB_URL='postgresql://LOCAL_USER:LOCAL_PASSWORD@127.0.0.1:5432/industry_dr_r36_trial123'
export AGE_IDENTITY_FILE='/absolute/private/age-identity.txt'
GUEST_R37_DR_ACK=RESTORE_DISPOSABLE_LOCAL_ONLY \
 node scripts/r37-local-dr.mjs --approved-local-restore PILOT_UUID R36_SOURCE_TREE_SHA /absolute/private/test-copy.age AGE_ARCHIVE_SHA256
```

Ни скрипт, ни CI **не создают или удаляют БД**. Пустую одноразовую локальную БД и AGE identity предоставляет только уполномоченный оператор. Время допуска ограничено 5 минутами. Репетиция, если запущена, **не является доказательством подлинной независимой offsite-копии** или production rollback. Реальная операция **не запускалась мной/CI**.

### 3. Фактическая локальная связка исходного релиза и запущенного образа

`src/guest-r37-image-provenance.mjs`, `scripts/r37-verify-container.mjs`, Dockerfile и `ops/compose.r14.yml` теперь поддерживают build arg `OSMANX_SOURCE_SHA` и два образных label: `org.opencontainers.image.revision`, `io.osmanx.guest.writes-default=false`. Без указания SHA label остаётся пустым и проверка отказоустойчива: не произойдёт ложного одобрения.

Оператор в локальной безопасной среде должен собрать **с заранее сверенным SHA** и проверить сам release manifest. Только после **отдельного** подтверждения `GUEST_R37_DOCKER_ACK=CHECK_LOCAL_READONLY_IMAGE` валидируется:

- `RELEASE.json` с правильными `fullCommit`, `commit` и `guestWritesDefault:false`;
- конкретный **запущенный** `osmanx-guest-r14-canary-api-1` с реальным content-addressed image ID;
- Docker image label SHA строго равен release manifest SHA;
- единственный открытый порт 3047/tcp привязан к `127.0.0.1:3150` и сеть canary изолирована.

```bash
cd services/industry-api
GUEST_R37_DOCKER_ACK=CHECK_LOCAL_READONLY_IMAGE \
 node scripts/r37-verify-container.mjs --approved-local-docker /absolute/release/industry-api/RELEASE.json EXPECTED_FULL_SHA
```

Запросы Docker read-only, ограничены строго фиксированным именем контейнера. Используется Docker `--format` только для id, runtime state, port bindings и image labels; **никакие Docker ENV/passwords не запрашиваются и не печатаются**.

Метаданные Docker labels контролируются сборщиком; они **не** являются подписью trusted builder. Этот локальный инструмент не проверяет рабочий VPS и не доказывает фактическую версию на удалённом staging.

### 4. Ручная цепочка 23 PR с обязательным свежим CI main

`src/guest-r37-postmerge.mjs`, `scripts/r37-main-gate.mjs`. Сначала проверяются предыдущие 22 PR и точный R36 PR #71, parent, source tree и пять CI `r36-*` на SHA `8da61929...`. Затем **через read-only GitHub GET** загружаются все 23 PR, реальный `refs/heads/main`, его Git tree и статус каждого из пяти `r36-*` **после** момента последнего ручного merge. Должны совпасть все SHA исходных PR, статусы merged и итоговое дерево. Отсутствующие, отклонённые или старые jobs не считаются принятыми.

```bash
cd services/industry-api
node scripts/r37-main-gate.mjs --github
```

Состояние на начало R37: [PR #47](https://github.com/osmanosmanov6880-bot/osmanx-world/pull/47) — Draft, без независимых одобрений. Он блокирует первый фактический merge. **Эта команда ничего не объединяет и не одобряет**. Даже полностью успешная проверка дерева main и пяти jobs не отменит отдельных проверок staging, offsite, договоров и разрешения на изменение production.

### 5. Сквозной NO-GO-кабинет, API и тесты

`src/guest-r37-report.mjs` создаёт SHA-256-связанный, не дольше 10 минут действующий отчёт из унаследованного R36. Доступны только **два MANAGE GET для owner/manager своей компании**:

- `GET /api/industry/v1/guest/pilots/:id/r37/readiness`
- `GET /api/industry/v1/guest/pilots/:id/r37/report.csv`

Формирование ответа не вызывает Docker, PostgreSQL restore, реальный staging или GitHub. Интерфейс полностью на русском, CSV защищён от formula injection, HTTP-ответы — `Cache-Control: no-store`. По умолчанию `guestWritesDefault:false`, `customerGo:false`, `productionAuthorized:false`. Пять CI jobs: `r37-offline`, `r37-postgres`, `r37-encrypted-dr`, `r37-reproducible`, `r37-release-graph`, плюс регрессия R7–R37.

## Незакрытые фактические внешние условия

1. Независимое ручное ревью PR #47 и последующая последовательная цепочка PR 47–71; окончательный CI на `main` после merge.
2. Разрешённая проверка **настоящего** staging с TLS, privacy/health и сопоставлением развёрнутого артефакта.
3. Реальное независимое offsite восстановление двух архивов, RTO/RPO, контроль строк и физический rollback на безопасной среде.
4. Юридическая проверка договоров, полномочий и законного основания, санкционированное изменение.
5. Техническое разрешение на production отдельно от успешного CI.

**Статус: NO-GO.** Автоматических merge, деплоя, отключения STOP, живых клиентских записей или использования реальных секретов нет.
