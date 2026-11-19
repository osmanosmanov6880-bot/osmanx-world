# OSMANX Guest Intelligence R35 — first real merge blocker, pinned staging and byte-level evidence

Дата: 20 ноября 2026. Основа: Draft R34 PR #69, immutable HEAD `d1c072296f48047a494de3629fcb6758b8e7216b`. R35 — новая Draft ветка поверх R34, без merge/deploy.

## Пять крупных инженерных блоков

### 1. Реальная очередь 21 PR и ревью первого блокирующего PR

`src/guest-r35-source.mjs`, `scripts/r35-review-github.mjs`. Источник — GET GitHub API. Проверяется вся последовательная цепочка 20 PR из R34 + R34 PR #69, точный HEAD, parent, пять поимённых успешных CI и Git-дерево. Для первого не объединённого PR дополнительно читаются `/pulls/{number}`, `/pulls/{number}/reviews` и checks точного HEAD. Зачёт одобрений только от **другого GitHub-логина** с `APPROVED` на текущем commit ID, проверяется Draft и head CI. Не выполняются merge, review submission или настройка branch protection.

**Проверенное фактическое состояние на начало R35:** [PR #47](https://github.com/osmanosmanov6880-bot/osmanx-world/pull/47) был открыт как Draft, ноль отзывов ревьюеров. Поэтому первое конкретное действие человека — перевести PR из Draft после оценки готовности, затем получить независимое code review. После него повторить цепочку: этот вывод может устареть, если PR изменится.

Запуск через разрешённый GitHub API token с правом READ:

```bash
cd services/industry-api
node scripts/r35-review-github.mjs --github
```

### 2. Явно разрешённый staging GET с закреплёнными IP и TLS

`src/guest-r35-staging.mjs`, `scripts/r35-staging-canary.mjs`. Оператор **до начала сетевых запросов** должен самостоятельно определить, проверить и указать: UUID одного тестового пилота, Git-tree SHA, *единственный* разрешённый публичный IPv4 staging и SHA-256 авторизованного TLS-сертификата. Только фиксированное имя `staging.osmanx.world` и только десять GET-запросов (5 маршрутов × 2 снимка), ответы 200 на health и 401 на закрытых endpoints. DNS обязан соответствовать **ровно** разрешённому IP на обеих проверках; используется закрепление сокета к этому IP, TLS CA/SNI, запрет redirects/credentials/записи клиентских данных. Профиль одобрения не дольше 10 минут; хеш профиля и наблюдений связываются с пилотом.

```bash
cd services/industry-api
GUEST_R35_OPERATOR_APPROVAL=APPROVED_STAGING_GET_ONLY \
  node scripts/r35-staging-canary.mjs --approved-staging PILOT_UUID R34_TREE_SHA ALLOWED_PUBLIC_IPV4 CERT_SHA256
```

**Важно:** реальный staging и его сертификат R35 не проверял в CI; тесты использовали подставные адаптеры. Код проверяет статусы, но не получает наблюдаемую версию опубликованного приложения из health endpoint, поэтому подтверждение идентичности deployed Git commit — отдельная внешняя обязанность.

### 3. Пересчёт реальных локальных байтов двух AGE-копий

`src/guest-r35-byte-proof.mjs`, `src/guest-r35-archive-bytes.mjs`. Оператор заранее предоставляет **два отдельных** зашифрованных AGE-архива и подписанный R34 custody statement. После проверки двух разных доверенных Ed25519 ключей, SHA источников и сроков система читает файлы потоково, защищает от симлинка / TOCTOU через `O_NOFOLLOW`, inode comparison, ограничивает размер каждого файла 64 МБ, проверяет AGE v1 envelope marker и сверяет реальные SHA-256 с **подписанными** значениями. Байты, пути и plaintext в готовый отчёт не копируются.

Это фактическая сверка зашифрованных файлов, но **не** подтверждение дешифрования, правильности данных, физического offsite хранения или восстановленной базы. Реальная независимая репетиция и откат по-прежнему необходимы.

### 4. Пересчёт реальных байтов пяти клиентских документов

`src/guest-r35-document-bytes.mjs`. Обязательны отдельные локальные файлы договора, processor agreement, privacy notice, lawful basis opinion и deletion procedure. Размер каждого до 8 МБ, без симлинков и выгрузки содержимого. Два независимых доверенных подписанта R34 должны подтвердить те же SHA, которые вычисляются по реально открытым документам. Несовпадение, подмена или повторное использование одного пути закрывает проверку.

**Юридическая оговорка:** наличие, подпись ключом и SHA совпадающего файла **не означает**, что правовое основание, полномочия клиента или содержание документа были независимо проверены юристом.

### 5. Единый R35 operator handoff + кабинет/API/CI

`src/guest-r35-handoff.mjs` объединяет точные 21 PR и первый открытый review, SHA staging, реальные SHA байтов двух AGE и пяти документов и одну цепочку tenant/pilot/tree. `scripts/r35-operator-audit.mjs` принимает ограниченный 256 КиБ JSON из stdin и четыре заранее независимо закреплённых PUBLIC Ed25519 keys из отдельного operator-owned файла, затем читает локальные архивы/документы, возвращает только краткий digest. Нет сети, деплоя, merge, реального восстановления или импорта файлов в веб API.

```bash
cd services/industry-api
R35_TRUSTED_PUBLIC_KEYS_FILE=/absolute/operator/pinned-public-keys.json \
  node scripts/r35-operator-audit.mjs --offline < /absolute/operator/redacted-r35-evidence.json
```

**API только для owner/manager своей компании:**
- `GET /api/industry/v1/guest/pilots/:id/r35/readiness`
- `GET /api/industry/v1/guest/pilots/:id/r35/report.csv`

Отчёт SHA-256 и CSV: TTL не более 10 минут, `Cache-Control: no-store`, защита от formula injection. Русский кабинет R35 показывает внешние блокировки и никуда не загружает файлы. CI пять jobs: `r35-offline`, `r35-postgres`, `r35-encrypted-dr`, `r35-reproducible`, `r35-release-graph`, включая регрессию R7–R35 и negative security cases. Release manifest содержит `byteEvidenceAndHumanReviewSupportedR35:true`, **`guestWritesDefault:false`**.

## Отдельные обязательные условия настоящего production GO

- Независимое ручное ревью первого PR и 21 PR в правильной последовательности; финальный CI на `main` **после** объединения.
- Разрешённый фактический staging/VPS и независимое свидетельство безопасности, работоспособности и deployed commit.
- Подлинное внешнее AGE дешифрование, восстановление, проверка данных и безопасный откат.
- Проверка договора, законного основания, полномочий подписантов и санкционированного окна.
- Явный отдельный производственный change approval и контроль STOP.

**Ни одно из этих внешних условий не утверждается выполненным самим R35. Статус всегда NO-GO**, без автоматического merge/deploy, production доступа и снятия STOP.
