# OSMANX Guest Intelligence R43 — закреплённые зависимости, проверка безопасности поставки и образа

20 ноября 2026. Базовый исходник — R42 Draft PR #81, HEAD `783f4ae4f06df441db521438812881b83a2b2554`. R43 Draft PR #84 наложен только на R42, `main` и production не затронуты.

## Пять полноценных блоков

### 1. Git-версионирование проверенного npm lockfile

Файл `services/industry-api/package-lock.json` впервые **реально добавлен в Git** и содержит **64 записи**, включая корневую и 63 установленных пакета. Он побайтово получен из успешно проверенного GitHub Actions R42 `44705058106`, артефакт `guest-r42-uncommitted-npm-lock-candidate`. SHA-256 файла неизменно закреплён в исходном коде: `d0453f56f370d9d5822ccb2116148e56f07acaccff66deb01d5fc280cbc4321a`. Временный workflow импорта из PR удалён.

`src/guest-r43-lock.mjs` отвергает изменение байтов, версий, обязательных корневых и транзитивных пакетов, небезопасный источник скачивания, отсутствие SHA512 SRI и install scripts. Корневые версии: `@fastify/cookie 11.1.5`, `fastify 5.12.8`, `pg 8.23.1`.

### 2. Сборка и тестирование с `npm ci`, SBOM и аудитом

`Dockerfile` заменил `npm install` на `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`. CI вместо `npm install` использует `npm ci` по файлу из Git. Это исключает незаметный пересчёт дерева зависимостей во время установки.

`scripts/r43-supply-verify.mjs` выводит JSON-проверку lockfile и SBOM из 63 пакетов (`name`, `path`, `version`, `integrity`). `src/guest-r43-audit-policy.mjs` анализирует актуальный `npm audit --omit=dev --json`: ошибку сети, отсутствующий формат или high/critical уязвимости **блокирует**; найденные moderate/low требуют дополнительного человеческого анализа. Артефакт CI: `guest-r43-committed-lock-sbom`. Проверка npm advisory зависит от доступности и актуальности npm Registry и не даёт юридического допуска.

### 3. Docker runtime smoke, изоляция и сокращённый build context

В проект добавлен строгий `.dockerignore` с allowlist исходного кода: исключены произвольные `.env`, backup, AGE ciphertext, PEM, ключи, тесты, git-метаданные и node_modules, чтобы не отправлять их в Docker-daemon. `Dockerfile` снабжает образ self-asserted labels source SHA, lock SHA, writes-default=false.

Шестое отдельное задание CI `r43-image-smoke` действительно собирает Docker-образ, проверяет его через `docker image inspect` и `scripts/r43-verify-image.mjs`, запускает импорт всех runtime-зависимостей без сети и с `--read-only --cap-drop ALL --security-opt no-new-privileges`. Проверяется пользователь `node`, отсутствие credential в image env, единственный EXPOSE `3047/tcp`, локальный readiness healthcheck. Артефакт: `guest-r43-local-image-policy`. **Ограничение:** исходный `node:22-bookworm-slim` не закреплён OCI digest, а образ не имеет независимой подписи и не развёрнут на реальном VPS.

### 4. Архив релиза содержит точно тот же lockfile

`ops/build-release.sh` копирует `package-lock.json` и `.dockerignore` в детерминированный архив и объявляет `committedDependencyLockAndImageSmokeR43:true`. `ops/verify-release.sh` требует точного SHA-256 lockfile и реально соответствующего `npm ci` в Dockerfile, все новые исходные модули и сохранённый `guestWritesDefault:false`. Применяется текущий `SHA256SUMS` каждого файла и отказ от произвольных файлов/симлинков в архиве. CI собирает два архива, сравнивает их и проверяет полный source contract. Контроль целостности не является независимой подписью издателя.

### 5. Независимое ревью цепочки PR

`src/guest-r43-review-chain.mjs` и `scripts/r43-review-chain.mjs` через GitHub GET проверяют head/base, SHA, Draft/status семи контрольных PR: #47, #74, #76, #77, #79, #81, #84. Текущее `main` читается дважды; сравнение `main...PR47` подтверждает реальное отставание первого PR. Проверка независимого approval принимает только явный `APPROVED` на текущем SHA от другого пользователя. Отчёт прямо сообщает, что семь PR не охватывают всю историческую цепочку R14–R37.

```bash
cd services/industry-api
node scripts/r43-supply-verify.mjs --lock
node scripts/r43-supply-verify.mjs --sbom
node scripts/r43-review-chain.mjs --github
node scripts/r43-review-chain.mjs --markdown
```

CI публикует `guest-r43-human-review-merge-order` для независимого ревьюера. **Никаких auto-review, auto-merge, запуска на VPS, разрешения записи клиентов или снятия STOP.**

## Итоговый контроль

Шесть jobs: `r43-offline`, `r43-postgres`, `r43-encrypted-dr`, `r43-reproducible`, `r43-release-graph`, `r43-image-smoke`. Сохранены Fastify/PostgreSQL R7–R42, tenant isolation, синтетические AGE restore и негативные проверки. Добавлены 7 тестов R43, реальный npm ci + npm audit, образ без сети и review handoff.

**Production NO-GO** до независимого ревью PR #47, подтверждения всех промежуточных PR и последовательного ручного merge; нового CI на финальном `main`, реального staging, offsite восстановления/отката, юридического и операционного допуска. Подписанный SBOM или зелёный локальный Docker-test не подменяют эти внешние требования.
