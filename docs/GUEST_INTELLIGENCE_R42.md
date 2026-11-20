# OSMANX Guest Intelligence R42 — PR47 merge drift, local backup hardening, custody signatures and npm inventory

Дата: 20 ноября 2026. R42 создаётся как отдельный **Draft** поверх R41 PR #79 (коммит `72e8e709fc53368457f302565d71f4302a358085`). Изменений действующего `main`, customer data, STOP и production не выполняется.

## Пять крупных инженерных задач

### 1. Живой read-only контроль PR #47 против текущего `main`

`src/guest-r42-merge-drift.mjs` и `scripts/r42-merge-audit.mjs` сравнивают фактический `main` с pinned первым source-коммитом `840bb083e606058a9a32450f3b3a3e881a34891e`. GitHub API `compare/<main>...<head>` показывает количество коммитов вперёд/назад, актуальную совместимость и факт смены `main` во время чтения. На старте R42 верифицировано: **2 commits behind**, **4 commits ahead**, `mergeable=true` / `clean`, но PR всё ещё `Draft`. Это не даёт права merge.

Чтение `GET /branches/main/protection` может вернуть **HTTP 403** для данной GitHub-интеграции. Это отмечается как `BRANCH_PROTECTION_NOT_INDEPENDENTLY_VERIFIED`; отсутствие доступа **не равняется** доказанной защите ветки. Рабочий процесс: независимый ревьюер, управляемое согласование новой базы, повторное одобрение нового HEAD, merge в правильном порядке, повторный CI на настоящем `main`. Никаких GitHub POST/PATCH.

```bash
cd services/industry-api
node scripts/r42-merge-audit.mjs --github
node scripts/r42-merge-audit.mjs --markdown
```

### 2. Защита прямого создания AGE backup

`src/guest-r42-backup-guard.mjs`, `scripts/r42-backup-preflight.mjs` и **действующий** `ops/backup-encrypted.sh` требуют:
- один абсолютный **существующий заранее** каталог с собственником оператором и mode 0700, вне checkout, без симлинков, включая родительские компоненты пути;
- только соединение к localhost/127.0.0.1/::1 с явно разрешённой локальной тестовой PostgreSQL БД (`industry_ci`, `guest_r14_canary` или отдельная `industry_dr_*`);
- два неповторяющихся AGE recipient и явное `GUEST_R42_BACKUP_ACK=CONFIRM_LOCAL_ENCRYPTED_BACKUP_NO_CUSTOMERS`;
- отказ от перезаписи уже существующих файлов: публикация ciphertext и sidecar производится через атомарное создание hardlink в приватном каталоге, с удалением неполной первой ссылки при сбое второго шага.

Plaintext `pg_dump` существует только во временном каталоге mode 0700 и удаляется по shell trap. Никакой production DB не принимается без отдельного нового утверждённого workflow; скрипт ограничен тестовой/изолированной средой. В CI реально создаются две независимые AGE-копии и проверяется отказ для каталога mode 0755 и отсутствующего ACK.

### 3. Проверка подписи независимого хранителя резервной копии

`src/guest-r42-custody-proof.mjs` + `scripts/r42-verify-custody.mjs` проверяют подписанную Ed25519 квитанцию по *точному* имени AGE-архива, его SHA-256, размеру, идентификатору хранителя, версии объекта, заявленному типу хранения, времени и сроку действия. Доверенный SHA-256 SPKI-пин публичного ключа хранителя поставляется независимо, аналогично R41. Дополнительные поля `customerGo`, подмена размера/хеша, неверная дата, отсутствие пина, новая подпись чужим ключом дают отказ.

```bash
cd services/industry-api
export GUEST_R42_CUSTODIAN_SPKI_SHA256='<verified 64-character lowercase SHA256>'
export GUEST_R42_EXPECTED_ARCHIVE_BYTES='<trusted ciphertext size>'
node scripts/r42-verify-custody.mjs /private/receipt.json /private/custodian.pub.pem '<archive sha256>' 'industry-YYYYMMDDTHHMMSSZ-N.dump.age'
```

Это **проверка подписанного заявления**, а не доказательство реального объекта хранения: `actualProviderObjectFetched=false`, `actualOffsiteRestoreWitnessed=false`, `proofOfExternalCustody=false`. Внешний оператор обязан проверить объект у провайдера и провести реальное восстановление.

### 4. Генерация и аудит npm lockfile для поставки

В дереве R41 существовал `package.json` с тремя закреплёнными версиями зависимостей, но **не существовало сохранённого `package-lock.json`**. Это означает, что `npm install` в CI не доказывает воспроизводимость установленного набора транзитивных пакетов.

`src/guest-r42-dependency-audit.mjs` и `scripts/r42-deps-review.mjs` проверяют создаваемый npm lock v3: три ожидаемые прямые версии, все вложенные версии, только registry.npmjs.org HTTPS URLs, SHA512 SRI, неожиданное исполнение install scripts, SHA-256 полного lockfile. CI выкладывает `guest-r42-uncommitted-npm-lock-candidate` как артефакт для ревью. Артефакт пока **не является частью исходного Git-дерева**, значит production dependency chain остаётся **NO-GO** до ручного добавления lockfile, повторного `npm ci --ignore-scripts` и security audit.

### 5. Полноценная CI-приёмка R42 и эксплуатационные действия

Наследуется R7–R41 PostgreSQL/Fastify, tenant isolation, no-guest-writes и воспроизводимый *source* release. Пять jobs: `r42-offline`, `r42-postgres`, `r42-encrypted-dr`, `r42-reproducible`, `r42-release-graph`.

Дополнительно тестируются реальная файловая система с каталогами mode 0700/0755 и симлинками, корректный/подменённый Ed25519 receipt через прямой CLI, изменение размеров архива, вырождение двух AGE-ключей, расхождение PR/main, отказ GitHub protection 403 и SRI tampering пакетов. GitHub Actions сохраняет `guest-r42-pr47-merge-drift-handoff` как Markdown-инструкцию ревьюеру.

## Что реально потребуется сделать человеком

1. Независимое ревью R14 PR #47 и последующей цепочки; устранить отставание первого PR от `main` и заново проверить CI на новом SHA
2. Администратору GitHub отдельно проверить branch protection/approval rules, недоступные integration token
3. Зафиксировать проверенный `package-lock.json` и перейти к `npm ci`, затем проверить уязвимости зависимостей
4. Проверить настоящий deployed staging, внешний объект backup и успешный offsite restore с RTO/RPO и rollback
5. Проверить законные основания, договоры, сроки хранения, разрешение владельца данных и change window

**Статус: production / customers — NO-GO.** Успех local CI, подпись документа или видимость GitHub mergeable не являются разрешением на запись данных гостей и не снимают STOP.
