# OSMANX Guest Intelligence R41 — trusted keys, fd-bound recovery and human review

20 ноября 2026. Базовый Draft R40: PR #77, коммит `5c9b1c4c3396c9ebaecbf605702eceff7a1a04a4`. R41 — независимый stacked Draft; `main` и production не изменяются.

## Пять крупных инженерных блоков

### 1. Независимая проверка отпечатков Ed25519-ключей R14

`src/guest-r41-key-pins.mjs` встроен в **прямой** `scripts/r14-admission.mjs --require-go`. Проверяется SHA-256 по каноническому `SPKI DER` каждого Ed25519 public key, два разных ключа и два независимо зафиксированных 64-символьных отпечатка. Подписанное мошенником решение на собственных новых ключах больше не считается operator GO, даже если Ed25519 математически верен.

```bash
cd services/industry-api
# Значения предоставляются и сверяются двумя независимыми операторами.
export GUEST_OWNER_PUBLIC_KEY_SHA256='<64 lowercase hex from trusted channel>'
export GUEST_MANAGER_PUBLIC_KEY_SHA256='<different 64 lowercase hex from trusted channel>'
node scripts/r14-admission.mjs /private/decision.json /private/owner.pub.pem /private/manager.pub.pem --require-go
```

При отсутствии pin или подмене ключа выдается **NO-GO**. Криптографическая подпись и доказательства по-прежнему проверяются исходным R14. Инструмент не создаёт ключи, не изменяет их и не включает запись гостей. Отпечатки должны поступать **вне контролируемой атакующим системы**, иначе требование не защищает от подмены.

### 2. AGE: атомарная копия через тот же открытый дескриптор

`src/guest-r41-age-snapshot.mjs`, `scripts/r41-snapshot-age.mjs` и реально используемый `ops/restore-dr.sh`. Убрано независимое `cp -P` исходного ciphertext после проверки метаданных. Исходный файл открывается один раз через защищённый R40 file descriptor. Поток копируется в заранее созданный оператором каталог `mktemp -d` (mode 0700) через файл `O_CREAT|O_EXCL|O_NOFOLLOW` с mode 0600. SHA-256 вычисляется на тех же байтах, сверяется с единственным точным исходным sidecar, затем генерируется **новый** sidecar уже в приватной копии.

Проверяются длины, inode, приватность AGE identity, отсутствие дополнительных hardlink, несовпадение байт и гонки размера. Дешифрование выполняется **только** с `$tmp/$name`. Проверка R40 повторно перепроверяет приватную копию, PostgreSQL R39 остаётся пустым и локальным, `pg_restore --single-transaction` сохраняется. Формула SHA не доказывает offsite custody и не защищает от оператора со злонамеренными системными полномочиями.

### 3. Запрет обхода защиты секретов при прямом вызове Compose

`scripts/r38-check-compose.mjs` теперь вызывает `openR40Regular(envFile,privateFile:true)` **до** `docker compose config`, даже когда запущен напрямую, без оболочки `r14-canary.sh`. Небезопасные chmod, симлинки по компонентам пути, hardlink, чужой uid, секрет в checkout и превышение 32 KiB заканчиваются отказом без Docker-вызова. Затем исполняются существующие проверки фактического Compose JSON, точного provision bind, loopback-порта, readonly и запрещённых привилегий. Ранее прямой вызов валидатора обходил часть R37 file preflight.

### 4. GitHub: байты каждого файла PR #47 связаны с зафиксированным Git tree

`src/guest-r41-git-tree.mjs` и `scripts/r41-first-pr-gate.mjs` используют только GitHub **GET**. Проверяются полный, `truncated:false` recursive Git tree точного pinned commit `840bb083e606058a9a32450f3b3a3e881a34891e`, все 10 путей, тип Git blob и точный SHA каждого файла из GitHub PR file inventory. Отдельно проверяется полный R40 unified diff. Подмена, недостающий файл или усечённый tree блокируют техническую приёмку. Дополнительно считывается актуальный `refs/heads/main`, который может независимо меняться. Нет предположения, что SHA PR = уже опубликованный `main`.

### 5. Готовый артефакт для независимого ревью PR #47

`src/guest-r41-review-gate.mjs` формирует SHA-256 связанный read-only NO-GO документ с шестью конкретными объектами code review, семью эксплуатационными шагами и актуальными блокировками первого PR: статус Draft, отсутствие независимого approval, неизвестная/отрицательная mergeability, отсутствие свежего финального CI `main`, внешнего staging и offsite restore. Команда выводит JSON или краткий Markdown:

```bash
cd services/industry-api
node scripts/r41-first-pr-gate.mjs --github
node scripts/r41-first-pr-gate.mjs --markdown
```

В CI Markdown публикуется как временный GitHub Actions artifact `guest-r41-pr47-review-guide`, доступный человеку для ревью. Никакого auto-approve/merge, снятия Draft или STOP, изменения секретов, внешней инфраструктуры и записи гостевых данных нет.

## CI и коммерческий допуск

Пять jobs: `r41-offline`, `r41-postgres`, `r41-encrypted-dr`, `r41-reproducible`, `r41-release-graph`. Наследуется полный регрессионный набор R7–R40; добавлены реальные Ed25519 keypairs с правильным и подменённым pin, безопасная файловая система, занятый порт/Docker env, три синтетических AGE restore, отказ hardlinked AGE ciphertext и точная проверка Git tree PR #47.

**Status: production NO-GO.** Нужно независимое человеческое ревью PR #47 и всех последующих зависимых изменений, ручной merge цепочки и новый CI итогового `main`. Отдельно требуются независимая проверка реального staging/deployed artifact, offsite восстановления и отката, RTO/RPO, договоры и законное основание обработки, утверждённое окно изменений. Успех CI не является коммерческим GO.
