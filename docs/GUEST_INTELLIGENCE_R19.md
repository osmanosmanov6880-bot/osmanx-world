# OSMANX Guest Intelligence R19 — управляемый первый клиентский пилот

19 ноября 2026. R19 — отдельный черновой PR поверх R18 #52, далее R17 #51, R16 #49, R15 #48, R14 #47. Нет автоматического слияния, деплоя, включения записи или юридического разрешения на обработку реальных данных.

## Пять реализаций

1. Подписанный независимым оператором Ed25519 scope.json для ровно одной пары tenant UUID и pilot UUID. Полный SHA релиза, SHA неизменяемого зарегистрированного протокола, контрольная точка R18, последовательность R17, срок до 7 дней, дневная квота 1–100. Три разных SHA-256 для договора, уведомления о приватности и свидетельства законного основания/согласий. Это лишь проверка целостности предъявленных документов, НЕ юридическая экспертиза.
2. scripts/r19-operator.mjs создаёт только новый 600 STOP при явном подтверждении. Причины: client_request, consent_withdrawn, security_incident, lawful_basis_expired. Нет HTTP/CLI автоматического снятия STOP. Остановка возможна без доступного API.
3. PostgreSQL миграция 014: FORCE RLS на дневной учёт операций и immutable журнале. Монотонный SQL-триггер запрещает откат или повышение лимита. Только новые успешные start/observations/observations/import расходуют слот. Идемпотентный повтор и ошибка не расходуют слот; rollback всей транзакции сохраняет целостность R17/R18 и данных. Экстренные R13 holds и предпросмотр CSV не ограничены дневной квотой.
4. Серверный контроль scope в app.mjs до и после бизнес-операции и прямо перед COMMIT. Tenant берётся из авторизованной сессии, pilot из строгого маршрута; состояние R13 и протокол проверяются в PostgreSQL. GET /api/industry/v1/guest/pilots/:id/r19/preflight отдаёт владельцу/управляющему только собственный пилот, сроки и лимит; приватные ключи не отдаются. Русская панель сообщает причины блокировки.
5. Read-only scripts/r19-first-client-rehearsal.mjs с PostgreSQL BEGIN READ ONLY, R16–R19 подписями, R13 holds, R12 enrolment, миграцией 014, локальным canary, budget, внешними контрольными точками и отчётом NO-GO. Node/PostgreSQL/Fastify и воспроизводимая сборка проходят отдельную CI.

## Защищённая приватная конфигурация (пример, НЕ включать без разрешения)

    GUEST_R19_SCOPE_FILE=/secure/osmanx-r19/pilot/scope.json
    GUEST_R19_OPERATOR_PUBLIC_KEY=/secure/osmanx-r19/trust/operator.pub.pem
    GUEST_R19_STOP_FILE=/secure/osmanx-r19/pilot/STOP
    GUEST_R19_MIN_SEQUENCE=3
    GUEST_R19_ROLLOUT_ENABLED=true

Это дополнение к R14–R18, включая их секретные вне-GitHub источники, и к внешнему GUEST_WRITES_ENABLED=true, который этот PR НИГДЕ не устанавливает. Если одна из переменных R19 задана неполно, сбор по защищённым маршрутам заблокирован. Действующие R12/R13/R16 остановки не снимаются. STOP и scope.json — chmod 600, без symlink; доверенный публичный ключ в другом каталоге. Закрытый ключ оператора остаётся на его отдельном устройстве.

## Точный перечень операций R19

Сбор ограничивается тремя POST-маршрутами: /guest/pilots/:id/start, /guest/pilots/:id/observations, /guest/pilots/:id/observations/import. Система считает успешные запросы, не число строк CSV. Предпросмотр, исправление агрегатов и аварийная пауза R13 не расходуют квоту. Другие операции регулируются R12–R18; для полного выключения всего гостевого ввода используйте независимый R16 global STOP.

## Образец НЕПОДПИСАННОГО scope для подготовки человеком

    {"schema":"osmanx.guest.r19.single-pilot-scope.v1",
     "tenantId":"00000000-0000-4000-8000-000000000001",
     "pilotId":"00000000-0000-4000-8000-000000000002",
     "releaseCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
     "checkpointDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
     "journalSequence":3,
     "protocolDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
     "policy":{"purpose":"repeat_visit_aggregate_only","maxDailyWrites":10,"retentionDays":30,
       "contractEvidenceSha":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
       "privacyEvidenceSha":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
       "consentEvidenceSha":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"},
     "actorId":"independent-operator",
     "issuedAt":"2026-11-19T08:00:00.000Z",
     "expiresAt":"2026-11-19T09:00:00.000Z"}

SHA, UUID и даты выше фиктивные. Владельцу/управляющему доступен SHA зарегистрированного протокола в R19 preflight, чтобы сверить его с частным документом. Три SHA доказательств должны соответствовать реально проверенным отдельным документам; один лишь хэш не является согласием человека. R12 подтверждают разные реальные сотрудники независимо от внешнего R19 подписанта.

## Подпись / аварийный STOP / read-only приёмка

На доверенной независимой машине оператора после сверки R18:

    cd services/industry-api
    node scripts/r19-operator.mjs sign /private/unsigned-scope.json /private/operator-private.pem /private/scope.json

Подписанный файл переносится в приватную инфраструктуру человеком. Этот скрипт не публикует подписанные данные и не активирует клиента. Для независимой необратимой остановки:

    node scripts/r19-operator.mjs stop consent_withdrawn CONFIRM_R19_PERMANENT_STOP

Повторный STOP безопасен, автоматического resume не существует. Для технического dry run:

    node scripts/r19-first-client-rehearsal.mjs --tenant TENANT_UUID --pilot PILOT_UUID

Используется только GET loopback-canary 127.0.0.1:3150 и SELECT внутри READ ONLY PostgreSQL transaction. Программа всегда возвращает legalGo:false, customerGo:false, changedProduction:false, offsiteStorageVerified:false даже при технически успешной проверке.

## Условия будущего реального запуска

Отдельно нужны: закрытые/слитые по порядку PR R14–R19, уполномоченный оператор VPS, подтверждённые договоры и законность обработки, сроки хранения и удаления данных, реальная внешняя WORM/retention-lock квитанция, восстановление двухключевого AGE архива на независимом DR, ответственные за инциденты и время контролируемого изменения. Этого CI не доказывает.

Границы гарантии: append-only/RLS работает для непривилегированного industry_app, не против администратора PostgreSQL; R19 does not prove actual customer consent; пилотный scope станет недействительным при смене подписанной R18 контрольной точки; отсутствие STOP без настоящего мониторинга не является доказательством законности. Все тесты синтетические.
