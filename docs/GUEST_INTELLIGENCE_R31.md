# OSMANX Guest Intelligence R31 — operator staging / independent evidence

Дата: 2026-11-19. Основа R30 PR #65, pinned HEAD `658bc5ac937e088d7a9d50b7946426d2b82b92f4`.

## Пять крупных реализаций

### 1. Цепочка 17 PR без автослияния
Модули `src/guest-r31-chain.mjs`, `scripts/r31-review-github.mjs`. Проверяются 16 предшественников, отдельно pinned R30 PR #65, исходный SHA, пять конкретных CI jobs, parent ancestry и Git tree, целевое дерево main. Обязательно различать source CI и fresh post-merge main CI. При отсутствии ручных merge — NO-GO, первый кандидат на code review определяется последовательностью PR. GitHub используется только по GET, без review-approve, merge, dispatch, push или deploy.

### 2. Реальный staging GET по инициативе оператора
`scripts/r31-approved-staging.mjs` строго ограничен 2 адресами: `http://127.0.0.1:3150` и **выделенным** `https://staging.osmanx.world`; это адрес предусмотренного staging, не доказательство его наличия. Продукционный `https://osmanx.world` никогда не вызывается этим инструментом. Десять GET-наблюдений: `/api/industry/v1/health/live`, `/health/ready`, приватные `/guest/pilots`, `/guest/pilots/<fixed fake UUID>/safety`, `/safety/export.json`. На приватных маршрутах обязан быть 401; для health 200. Не допускаются редиректы, cookies, auth-заголовки, произвольные URL, телеответы или POST. Тайм-аут на каждый запрос 5 секунд. Сбой выдаёт 599 и отказ технической приёмки.

**Реальный запрос не выполняется из web API или GitHub CI.** Только на согласованной staging-машине после проверки, что выделенный домен и loopback принадлежат именно staging:

```bash
cd services/industry-api
GUEST_R31_OPERATOR_APPROVAL=APPROVED_READ_ONLY_STAGING \
  node scripts/r31-approved-staging.mjs --approved-staging PILOT_UUID
```

Требуется предварительное разрешение оператора и замена `PILOT_UUID` на UUID разрешённого тестового пилота. Снимок с SHA-256 можно передать на независимое рассмотрение. Он имеет источник `operator-claimed` и **не доказывает независимую аттестацию VPS**.

### 3. Две независимые копии DR
`src/guest-r31-dr-review.mjs` — строгая метаформа офлайн-приёмки двух AES/AGE зашифрованных копий `A/B` с отдельными fingerprints ключей и архивов, раздельными одноразовыми базами `industry_dr_r31_*`, совпадением контрольных SHA и чисел строк, ограничением по времени/пилоту. Не принимает реальную базу `industry_ci` или необработанное PII. **Не выполняет физическое восстановление**, внешнее WORM-хранение или проверку прав владельца. Эти действия должны быть отдельно засвидетельствованы человеком вне продукта.

### 4. Подписанный сквозной офлайн-комплект
`src/guest-r31-evidence-bundle.mjs` сопоставляет SHA четырёх свидетельств из R30 с хешами конкретных доказательств R31: GitHub source graph, staging-снимка, двухкопийной DR-метаформы и brief приватности. Проверяет разные trusted Ed25519 keys, точную привязку tenant/pilot/release, nonce и десятиминутное окно. Нельзя присылать произвольные публичные ключи из браузера — доверенные ключи заранее закрепляет внешний ответственный. Даже все четыре верные подписи не означают, что факты являются правдой и что законные разрешения есть.

### 5. Кабинет и acceptance
`src/guest-r31-report.mjs`, `src/guest.mjs`, `assets/guest/console.html` и `console.js` добавляют русский кабинет R31 и два исключительно tenant-MANAGE GET:

- `GET /api/industry/v1/guest/pilots/:id/r31/readiness`
- `GET /api/industry/v1/guest/pilots/:id/r31/report.csv`

Реализация сохраняет 401 anonymous, 404 cross-tenant, 200 owner/manager, отсутствие SQL-изменений, `Cache-Control: no-store`, SHA-256, expiry ≤10 минут и защищённый CSV. Обновлён source-release manifest с `manualStagingOperatorSupportedR31:true` и обязательным `guestWritesDefault:false`. Проверяются unit/negative tests, RU UI, полный реальный PostgreSQL/Fastify регрессионный набор, AGE DR, воспроизводимые пакеты и read-only CI графа.

## Безусловные блокировки и критерии фактической публикации

Статус в web UI **NO-GO** и `productionAuthorized:false`. Предшествующие PR Draft, реальный staging/VPS не проверен за счёт CI, нет независимого offsite/WORM custody/DR, человеческого code review, legal/contract approval, утверждённого окна изменений, реального rollback и fresh post-merge main CI. R31 не делает merge, deploy, migrate, activate collection, STOP lift или действия с клиентскими данными. Эти внешние действия должны быть проверены отдельно от синтетических тестов и только с разрешения ответственных.
