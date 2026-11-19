# OSMANX Guest Intelligence R36 — предметное ревью, содержимое staging и локальный AGE restore

Дата: 20 ноября 2026. Стековый Draft поверх R35 PR #70, pinned HEAD `3e4d0609950fbc315947481cf4e431a0afe87e67`. Ни `main`, ни production не изменяются.

## Пять законченных инженерных блоков

### 1. Контроль 22 последовательных PR и статуса реального ревью

`src/guest-r36-source.mjs`, `scripts/r36-review-github.mjs --github`. Выполняют **только GET** к GitHub. Проверяют все 21 исходный PR из R35 и точный PR #70 (SHA, parent, tree, base, пять поимённых CI). Для **первого** ожидающего PR получают актуальный HEAD, историю reviews и check-runs с постраничной загрузкой до лимита и отказом при незавершённой пагинации. Теперь учтены отменённые/устаревшие одобрения и запросы на изменение: только последний валидный `APPROVED` на текущем SHA от другого логина подходит как сигнал ревью. Никаких merge, review submission, approval, auto-deploy.

**Факт на момент начала R36:** [PR #47](https://github.com/osmanosmanov6880-bot/osmanx-world/pull/47) — Draft, без отзывов; check-runs HEAD присутствуют. Выход из Draft и официальное независимое ревью — действие пользователя/ревьюеров после проверки кода, **не автоматическое действие этой системы**. Если PR меняется, данные пересчитываются.

### 2. Предметный список файлов PR #47 для независимого специалиста

`src/guest-r36-patch-audit.mjs` формирует SHA-256 инвентаря изменённых файлов и хеши доступных patch-фрагментов. Группы: Docker/canary/rollback, подписи допуска, мониторинг и инциденты, GitHub Actions, тесты, release-документы. Незавершённая пагинация, отсутствующий patch, путь вне дерева, дублирование или отсутствие ожидаемого `compose.r14.yml` приводят к предупреждению. Это **чек-лист**, а не автоматическая экспертная проверка безопасности и не одобрение PR. Исходная проверка выявила десять файлов PR #47.

### 3. Семантическая read-only проверка staging

`src/guest-r36-staging-content.mjs` + `scripts/r36-staging-canary.mjs`. При **явном разрешении оператора** запускаются 10 GET (два раунда по 5) только к `staging.osmanx.world`, с закреплёнными одним разрешённым публичным IPv4 и SHA-256 проверенного TLS-сертификата, TLS CA/SNI, без cookies, авторизации, редиректов и запросов на изменение. С каждым запросом сверяется содержимое bounded JSON (не более 4 КиБ): live status, ready database/schema/forced RLS/guestWritesEnabled=false, корректное 401 и error JSON на трёх приватных маршрутах. Отчёт не содержит тел ответов; запоминает только valid/status и SHA входного approval. Без ожидания 30 секунд и до 10 минут между двумя наблюдениями проверка отклоняется.

Операторские аргументы и переменные указываются после независимой проверки прав на staging, IP, сертификат и тестовый пилот:

```bash
cd services/industry-api
GUEST_R36_OPERATOR_APPROVAL=APPROVED_SEMANTIC_STAGING \
  node scripts/r36-staging-canary.mjs --approved-staging PILOT_UUID R35_TREE_SHA PUBLIC_IPV4 TLS_CERT_SHA256
```

Тесты GitHub используют искусственные ответы, не подключаются к реальному staging. Код не может независимо доказать, что staging обслуживает **конкретный** Git-commit: требуется отдельная внешняя аттестация deployed artifact.

### 4. Настоящий локальный AGE → PostgreSQL DR restore по отдельному разрешению

`src/guest-r36-disposable-restore.mjs` и `scripts/r36-disposable-restore.mjs` проверяют точный пилот/дерево/release, AGE SHA, TTL не более пяти минут, operator ACK, идентификатор базы и URL. Допускается только `127.0.0.1`/`localhost`/`::1`, только БД с именем `industry_dr_r36_*`, без query-строк. До запуска команды проверяются реальные байты AGE-архива по SHA и права локального файла ключа. Затем **только после явного подтверждения** существующий `ops/restore-dr.sh` проверяет пустую изолированную базу, расшифровывает AGE и выполняет pg_restore. CI тестирует fail-closed и адаптеры, **не выполняет реальный restore**.

```bash
cd services/industry-api
export DR_RESTORE_DB_URL='postgresql://operator:REDACTED@127.0.0.1:5432/industry_dr_r36_trial123'
export AGE_IDENTITY_FILE='/absolute/operator/age-identity.txt'
GUEST_R36_RESTORE_ACK=RESTORE_DISPOSABLE_LOOPBACK_ONLY \
  node scripts/r36-disposable-restore.mjs --approved-local-restore PILOT_UUID R35_TREE_SHA /absolute/offline/copy.age ARCHIVE_SHA256
```

В реальном запуске пароль передаётся только секретным окружением оператора, не в GitHub/чате/документации. Перед запуском оператор обязан сам создать **одноразовую пустую базу** в безопасной локальной среде. Исходники не создают БД и не дают команды на восстановление production. Положительный результат локальной операции не заменяет независимый offsite-custody witness, RPO и репетицию отката.

### 5. R36 кабинет/API/CI/документация

`src/guest-r36-report.mjs`: SHA-256, TTL до 10 минут, неизменяемые основания NO-GO. Только два аутентифицированных tenant-scoped MANAGE GET:

- `GET /api/industry/v1/guest/pilots/:id/r36/readiness`
- `GET /api/industry/v1/guest/pilots/:id/r36/report.csv`

Русский кабинет показывает цепочку из 22 PR, причины отказа, отсутствие независимого staging/DR и CSV. Веб-процесс не получает GitHub токены, AGE identity, внешние архивы/документы или новые write API. `guestWritesDefault:false`. Пять CI jobs `r36-offline`, `r36-postgres`, `r36-encrypted-dr`, `r36-reproducible`, `r36-release-graph`.

## Условия реального коммерческого GO остаются внешними

Независимые ревьюеры должны последовательно проверить и объединить PR; нужен новый полный CI итогового `main`. Staging/VPS должен быть проверен **живыми** разрешёнными запросами и сверкой развёрнутой версии, а внешняя копия восстановлена с независимым свидетельством и реальным тестом безопасного отката. Требуются действительные клиентские документы, законное основание и change approval. Пока ничего из этого не заявляется завершённым в R36.

**R36 — Draft, production NO-GO; автоматические merge/deploy/guest writes/STOP lift отсутствуют.**
