# OSMANX Guest Intelligence R32 — independent human cutover preflight

Дата: 19 ноября 2026. Стековый релиз поверх R31 PR #66, pinned HEAD `0e39e243162dd48c84eb790539d97439e969a65a`. `main` и production остаются неизменными.

## Реализованы 5 крупных блоков

### 1. Контроль 18 последовательных PR

`src/guest-r32-source.mjs`, `scripts/r32-review-github.mjs --github`. Проверяются все предшествующие 17 PR, точный R31 #66 SHA, branch/base, родительский SHA и пять поимённых CI jobs. Учитываются Git-tree и отдельно отсутствие заверенного CI *после* ручного merge в `main`. Первым незакрытым пунктом остаётся ручное review/merge исходного PR (по наблюдаемой цепочке). Ни одна функция не выполняет merge/deploy/dispatch.

### 2. Двухстороннее утверждение staging-окна

`src/guest-r32-change-window.mjs` требует две независимые роли: `release_manager` и `recovery_lead`, разные доверенные Ed25519 публичные ключи, собственные nonce, подписи утверждённого строгого JSON. Включает tenantId/pilotId, точную версию и дерево R31, rollback runbook SHA-256, SHA копий DR, начало/окончание до 30 минут, только `https://staging.osmanx.world`. Автоматическое действие не запускается даже при двух успешных подписях. Ключи должны быть **заранее доверенно закреплены независимым оператором**, не из входящего пакета.

### 3. Двойной staging drift-контроль

`src/guest-r32-staging-drift.mjs`: две отдельные ограниченные 10-минутным сроком записи по 10 GET-наблюдений, с расстоянием 30 секунд — 10 минут. Каждый HTTP статус должен отвечать модели: health 200, приватные API 401; нельзя редиректы, cookies, ответные тела, чужой пилот, старый release SHA, дублированные evidence SHA. Полученные извне `operator-claimed` snapshots — **не доказательство**, что реальный staging действительно проверялся. Физический сетевой запуск возможен только оператором через ранее реализованный `scripts/r31-approved-staging.mjs`; CI и веб-API не вызывают staging.

### 4. Контроль RTO/RPO из двух восстановленных копий

`src/guest-r32-recovery-objectives.mjs` строго связывает два отдельных disposable-restore с SHA двух архивов, контрольными суммами и числом строк, измеряет RTO (время восстановления) и RPO (задержка последнего восстановленного события). Отклоняет негативную или обращённую хронологию, чужой пилот и нарушение целевых 0–60 минут. Это арифметическая офлайн-проверка метаданных; живое восстановление, offsite/WORM и настоящий rollback не проводятся автоматически.

### 5. Действующий офлайн-процесс, сервер, русский кабинет, CI

- `src/guest-r32-preflight.mjs` связывает окна, staging, DR и цепочку исходников. Возвращает `eligibleForHumanAudit:true` только при валидных технических метаданных и подписях, **одновременно всегда `productionAuthorized:false`**.
- `scripts/r32-offline-preflight.mjs --offline` принимает JSON из stdin (не больше 512KiB), отдельный заранее закреплённый trusted keys file вне приложения, не загружает данные на сервер. Пример оператора после самостоятельного сбора и подписания доказательств:

```bash
cd services/industry-api
R32_TRUSTED_PUBLIC_KEYS_FILE=/absolute/path/approved-public-keys.json \
  node scripts/r32-offline-preflight.mjs --offline < redacted-r32-evidence.json
```

Доверенные публичные ключи должны быть проверены независимо от присланных доказательств, файл должен быть обычным, без права групповой/общей записи. Никаких private keys в GitHub, API или staging.

- Кабинет: `GET /api/industry/v1/guest/pilots/:id/r32/readiness` и `GET /api/industry/v1/guest/pilots/:id/r32/report.csv`; только роли owner/manager, tenant isolation, `Cache-Control: no-store`, TTL не больше 10 минут, SHA-256 и защищённый CSV.
- CI: пять jobs `r32-offline`, `r32-postgres`, `r32-encrypted-dr`, `r32-reproducible`, `r32-release-graph`. Синтетические проверки staging/DR и PostgreSQL регрессионные тесты не дают production GO.
- Source-release manifest: `humanCutoverPreflightSupportedR32:true` и строго `guestWritesDefault:false`.

## Условия фактической коммерческой публикации

Статус R32 в браузере — **NO-GO**, даже если все CI jobs зелёные. По-прежнему необходимы независимый code review и ручное последовательное объединение всех предшествующих PR, CI итогового `main`, подтверждённые операторами реальные staging/VPS/HTTPS, независимое offsite/WORM custodian подтверждение, фактический тест восстановления и отката, договор/правовое основание с клиентом и санкционированное окно изменений. R32 не выполняет merge, миграции, развёртывание, сбор реальных клиентских данных или снятие STOP.
