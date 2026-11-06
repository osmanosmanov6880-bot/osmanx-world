# OSGARD SUPREME DIRECTOR — текущий аудит 180 задач

Обновлено: 6 ноября 2026. Исходный мастер 17 октября 2026, SHA-256 `71fdda8231e1cb627a36fa683eaab1c28e4bdff2da9c95e0e6f6df83624a4b6c`.
Кодовый снимок: `2ca1d2c9034ac2b6ac86af12bfa21a1caec3f06c`.

**33 задачи со связанным локальным кодом; 139 без прямого доказательства; 4 SkillCred за пределами scope; 4 Noor заблокированы отсутствующими исходниками; 0/180 независимо принято.**

## Wave 6 — локальный код, не независимая приёмка

- TITAN-X19 — ограниченное inspect-first восстановление испорченных workflow-правил, максимум 3 отключения за проход, проверка хеша плана, immutable SQLite receipt.
- TITAN-X20 — транзакционное добавление, перемещение, удаление секций с историей ревизий и проверкой прав в одной SQLite-транзакции.
- TITAN-X21/X22 — автоматический запуск локальных record.created/record.updated правил в транзакции с соответствующей записью, без внешних эффектов и самозапуска.
- TITAN-X22 — отдельная браузерная проверка Chromium: реальные клики, API, Desktop 1440px, Mobile 390px, screenshot artifacts. Статус см. в GitHub Actions; коммит тестов сам по себе не доказывает прохождение.
- TITAN-X23 — действующие проектные роли и запреты сохранены; в этом проходе новые исходные ID по нему не добавлены.

Ограничения: нет owner-approved оригинальных upstream для всех шести направлений, нет независимой проверки реального deployment, browser security assessment и production authorization. Draft PR #7 остаётся без слияния.

| ID | Приоритет | Исходная задача | Доказательство | Связанный локальный код (не приёмка) |
|---|---|---|---|---|
| TITAN-X01 | P0 | Канонические Git baseline всех инженерных компонентов | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/recovery/ORIGINAL_180_TASKS.json`, `supreme-director/campaign180/campaign180/registry.py` |
| TITAN-X02 | P0 | Реестр исходников, пакетов и зависимостей | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/scripts/verify_source_transfer.py`, `supreme-director/campaign180/campaign180/registry.py` |
| TITAN-X03 | P0 | CODEOWNERS и контроль конфликтов изменений | RELATED_LOCAL_CODE_NOT_ACCEPTED | `.github/CODEOWNERS`, `supreme-director/campaign180/campaign180/gates.py` |
| TITAN-X04 | P0 | Воспроизводимые сборки и подписанные артефакты | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/m198/verify_source.py` |
| TITAN-X05 | P0 | Восстановление отсутствующих test dependencies | RELATED_LOCAL_CODE_NOT_ACCEPTED | `.github/workflows/supreme-director-m206.yml` |
| TITAN-X06 | P0 | Унифицированный контракт TaskEnvelope / ResultEnvelope | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/campaign180/campaign180/contracts.py` |
| TITAN-X07 | P0 | Identity, tenant mapping и scopes | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/m192/osgard_m192/runtime.py`, `supreme-director/campaign180/campaign180/access.py`, `supreme-director/campaign180/campaign180/gateway.py` |
| TITAN-X08 | P0 | RBAC и deny-by-default authorization | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/m192/tests/test_runtime.py`, `supreme-director/campaign180/campaign180/access.py`, `supreme-director/campaign180/campaign180/gateway.py` |
| TITAN-X09 | P0 | Защищённый sandbox исполнения задач | NO_DIRECT_PROOF | — |
| TITAN-X10 | P0 | Лимиты CPU, RAM, диска и сети | NO_DIRECT_PROOF | — |
| TITAN-X11 | P1 | DevSwarm durable queue и транзакционные leases | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/campaign180/campaign180/queue.py`, `supreme-director/campaign180/campaign180/gateway.py` |
| TITAN-X12 | P1 | Fencing и exactly-once-effect через идемпотентность | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/m205/osgard_m205/runtime.py`, `supreme-director/campaign180/campaign180/queue.py`, `supreme-director/campaign180/campaign180/gateway.py` |
| TITAN-X13 | P1 | Восстановление после сбоя worker | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/campaign180/campaign180/queue.py`, `supreme-director/campaign180/campaign180/gateway.py` |
| TITAN-X14 | P1 | Многопроцессный и многосерверный scheduler | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/campaign180/campaign180/scheduler.py`, `supreme-director/campaign180/tests/test_scheduler_backup.py` |
| TITAN-X15 | P1 | Планирование ресурсов и admission control | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/campaign180/campaign180/scheduler.py`, `supreme-director/campaign180/tests/test_scheduler_backup.py` |
| TITAN-X16 | P1 | Этапы brief-to-spec-to-code-to-release | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/campaign180/campaign180/workflow.py` |
| TITAN-X17 | P1 | Генерация кода из проверяемой спецификации | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/campaign180/campaign180/builder.py`, `supreme-director/campaign180/tests/test_builder_drafts_records_preview.py` |
| TITAN-X18 | P1 | Независимая проверка патчей и policy gates | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/m190/verify_source.py`, `supreme-director/campaign180/campaign180/review.py` |
| TITAN-X19 | P1 | Автоматизированное исправление ошибок с лимитами | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/campaign180/campaign180/repair.py`, `supreme-director/campaign180/tests/test_wave6_repair.py` |
| TITAN-X20 | P1 | Полноценный no-AI редактор страниц | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/campaign180/campaign180/builder.py`, `supreme-director/campaign180/campaign180/drafts.py`, `supreme-director/campaign180/campaign180/structure.py`, `supreme-director/campaign180/tests/test_wave6_structure_automatic.py`, `supreme-director/campaign180/assets/console.js` |
| TITAN-X21 | P1 | Визуальные формы, таблицы и связи данных | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/campaign180/campaign180/builder.py`, `supreme-director/campaign180/campaign180/records.py`, `supreme-director/campaign180/campaign180/automatic.py`, `supreme-director/campaign180/tests/test_wave6_structure_automatic.py` |
| TITAN-X22 | P1 | API и workflows в визуальном конструкторе | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/campaign180/campaign180/app_runtime.py`, `supreme-director/campaign180/campaign180/local_http.py`, `supreme-director/campaign180/assets/console.js`, `supreme-director/campaign180/tests/test_app_console.py`, `supreme-director/campaign180/campaign180/automatic.py`, `supreme-director/campaign180/campaign180/structure.py`, `supreme-director/campaign180/tests/browser-console.mjs`, `supreme-director/campaign180/tests/test_wave6_structure_automatic.py` |
| TITAN-X23 | P1 | Политики и разрешения в созданных приложениях | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/campaign180/campaign180/app_policy.py`, `supreme-director/campaign180/campaign180/app_runtime.py`, `supreme-director/campaign180/campaign180/local_http.py`, `supreme-director/campaign180/tests/test_app_console.py` |
| TITAN-X24 | P1 | Версионирование, импорт и экспорт проектов | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/campaign180/campaign180/drafts.py`, `supreme-director/campaign180/examples/demo-site.json` |
| TITAN-X25 | P1 | Система превью, тестовых окружений и публикации | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/campaign180/campaign180/preview.py`, `supreme-director/campaign180/examples/demo-site.json`, `supreme-director/campaign180/tests/test_builder_drafts_records_preview.py` |
| TITAN-X26 | P2 | CI/CD, dependency и secrets scanning | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/campaign180/campaign180/supplychain.py`, `supreme-director/campaign180/tests/test_review_supplychain.py` |
| TITAN-X27 | P2 | Observability, SLO, трассировка и audit | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/m206/osgard_m206/runtime.py` |
| TITAN-X28 | P2 | Backup/restore и сценарии аварийного возврата | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/m191/recovery.py`, `supreme-director/campaign180/campaign180/backup.py`, `supreme-director/campaign180/tests/test_scheduler_backup.py` |
| TITAN-X29 | P2 | Нагрузочные, хаос- и security-испытания | NO_DIRECT_PROOF | — |
| TITAN-X30 | P2 | Интеграционный KRAKEN–NEXUS–Command релиз-кандидат | NO_DIRECT_PROOF | — |
| NEXUS-X01 | P0 | Канонические Git baseline и реестр моделей | NO_DIRECT_PROOF | — |
| NEXUS-X02 | P0 | Утверждённый DecisionRef и capability intent contract | NO_DIRECT_PROOF | — |
| NEXUS-X03 | P0 | Trusted identity binding для всех операций | NO_DIRECT_PROOF | — |
| NEXUS-X04 | P0 | Tenant isolation и document-level ACL | NO_DIRECT_PROOF | — |
| NEXUS-X05 | P0 | Версионированный граф решений ÆTHERION | NO_DIRECT_PROOF | — |
| NEXUS-X06 | P0 | Система альтернатив и критериев решений | NO_DIRECT_PROOF | — |
| NEXUS-X07 | P0 | Provenance, digest и воспроизводимость ссылок | NO_DIRECT_PROOF | — |
| NEXUS-X08 | P0 | Независимые checkpoints журнала доказательств | NO_DIRECT_PROOF | — |
| NEXUS-X09 | P0 | Revocation и expiry принятых полномочий | NO_DIRECT_PROOF | — |
| NEXUS-X10 | P0 | Защищённый gateway инструментов | NO_DIRECT_PROOF | — |
| NEXUS-X11 | P1 | Ограничения запросов, размеров, времени и бюджетов | NO_DIRECT_PROOF | — |
| NEXUS-X12 | P1 | Защита от prompt injection и untrusted retrieval | NO_DIRECT_PROOF | — |
| NEXUS-X13 | P1 | Jarvis: память с изоляцией пользователей | NO_DIRECT_PROOF | — |
| NEXUS-X14 | P1 | Jarvis: разрешённые workflows и подтверждения | NO_DIRECT_PROOF | — |
| NEXUS-X15 | P1 | Jarvis: offline fallback и восстановление | NO_DIRECT_PROOF | — |
| NEXUS-X16 | P1 | Jarvis: безопасный голосовой интерфейс | NO_DIRECT_PROOF | — |
| NEXUS-X17 | P1 | MAGNEX: конвейер загрузки документов | NO_DIRECT_PROOF | — |
| NEXUS-X18 | P1 | MAGNEX: версионированный индекс и обновление | NO_DIRECT_PROOF | — |
| NEXUS-X19 | P1 | MAGNEX: гибридный retrieval и reranking | NO_DIRECT_PROOF | — |
| NEXUS-X20 | P1 | MAGNEX: цитирование и проверяемые evidence IDs | NO_DIRECT_PROOF | — |
| NEXUS-X21 | P1 | MAGNEX: revocation и удаление из кэша | NO_DIRECT_PROOF | — |
| NEXUS-X22 | P1 | Реальный retrieval evaluation corpus | NO_DIRECT_PROOF | — |
| NEXUS-X23 | P1 | Ollama: инвентаризация моделей и аппаратуры | NO_DIRECT_PROOF | — |
| NEXUS-X24 | P1 | CPU/GPU benchmark и контроль VRAM | NO_DIRECT_PROOF | — |
| NEXUS-X25 | P1 | Model router по качеству, затратам и правам | NO_DIRECT_PROOF | — |
| NEXUS-X26 | P2 | Fallback, timeouts и circuit breakers моделей | NO_DIRECT_PROOF | — |
| NEXUS-X27 | P2 | Модельные адаптеры для GENESIS/HUMAN | NO_DIRECT_PROOF | — |
| NEXUS-X28 | P2 | Read-only интеграция с TITAN execution | NO_DIRECT_PROOF | — |
| NEXUS-X29 | P2 | Staging E2E, attack tests и restore | NO_DIRECT_PROOF | — |
| NEXUS-X30 | P2 | Независимый аудит интеллектуального ядра | NO_DIRECT_PROOF | — |
| COMMERCE-X01 | P0 | Канонические исходники всех бизнес-продуктов | NO_DIRECT_PROOF | — |
| COMMERCE-X02 | P0 | Схемы PostgreSQL и безопасные миграции | NO_DIRECT_PROOF | — |
| COMMERCE-X03 | P0 | Row-Level Security и отрицательные тесты | NO_DIRECT_PROOF | — |
| COMMERCE-X04 | P0 | Подключение общего identity и tenant mapping | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/m192/osgard_m192/runtime.py` |
| COMMERCE-X05 | P0 | Серверные RBAC, аудит и управление сессиями | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/m192/osgard_m192/runtime.py` |
| COMMERCE-X06 | P0 | Модель клиентов и организаций | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/m193/osgard_m193/runtime.py` |
| COMMERCE-X07 | P0 | CRM: воронка продаж, сделки и задачи | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/m194/osgard_m194/runtime.py` |
| COMMERCE-X08 | P0 | CRM: проекты, этапы и обязательства | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/m196/osgard_m196/runtime.py` |
| COMMERCE-X09 | P0 | Клиентский кабинет с независимым доступом | NO_DIRECT_PROOF | — |
| COMMERCE-X10 | P0 | Документы, версии и безопасные вложения | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/m197/osgard_m197/runtime.py` |
| COMMERCE-X11 | P1 | Предложения и протокол согласований | NO_DIRECT_PROOF | — |
| COMMERCE-X12 | P1 | Событийная интеграция CRM и приложений | NO_DIRECT_PROOF | — |
| COMMERCE-X13 | P1 | Privacy: экспорт клиентских данных | NO_DIRECT_PROOF | — |
| COMMERCE-X14 | P1 | Privacy: удаление, retention и backup policy | NO_DIRECT_PROOF | — |
| COMMERCE-X15 | P1 | Outreach: consent provenance и версии | NO_DIRECT_PROOF | — |
| COMMERCE-X16 | P1 | Outreach: expiry, revocation и suppression | NO_DIRECT_PROOF | — |
| COMMERCE-X17 | P1 | Outreach: атомарный send-time authorization | NO_DIRECT_PROOF | — |
| COMMERCE-X18 | P1 | Outreach: durable outbox и восстановление | NO_DIRECT_PROOF | — |
| COMMERCE-X19 | P1 | Outreach: idempotency и frequency caps | NO_DIRECT_PROOF | — |
| COMMERCE-X20 | P1 | Outreach: провайдерский mock и receipts | NO_DIRECT_PROOF | — |
| COMMERCE-X21 | P1 | Outreach: конкурентные проверки и гонки | NO_DIRECT_PROOF | — |
| COMMERCE-X22 | P1 | SOULMATCH: карточки с evidence и provenance | NO_DIRECT_PROOF | — |
| COMMERCE-X23 | P1 | SOULMATCH: ручная проверка и объяснения | NO_DIRECT_PROOF | — |
| COMMERCE-X24 | P1 | SOULMATCH: интеграция read-only с MAGNEX | NO_DIRECT_PROOF | — |
| COMMERCE-X25 | P1 | FluxSend: Decimal и minor-unit арифметика | NO_DIRECT_PROOF | — |
| COMMERCE-X26 | P2 | FluxSend: валютные exponent, rounding, invariants | NO_DIRECT_PROOF | — |
| COMMERCE-X27 | P2 | FluxSend: audit, reconciliation и sandbox reports | NO_DIRECT_PROOF | — |
| COMMERCE-X28 | P2 | Русскоязычный premium CRM UI с реальными API | RELATED_LOCAL_CODE_NOT_ACCEPTED | `supreme-director/m193/README.md` |
| COMMERCE-X29 | P2 | HTTP E2E, mobile accessibility и performance | NO_DIRECT_PROOF | — |
| COMMERCE-X30 | P2 | Staging, backup/restore и security acceptance | NO_DIRECT_PROOF | — |
| EXPERIENCE-X01 | P0 | Канонические источники и SHA шести продуктов | NO_DIRECT_PROOF | — |
| EXPERIENCE-X02 | P0 | Раздельные доменные схемы, tenant и RBAC | NO_DIRECT_PROOF | — |
| EXPERIENCE-X03 | P0 | PHANTOM: транзакционная модель бронирования | NO_DIRECT_PROOF | — |
| EXPERIENCE-X04 | P0 | PHANTOM: конкуренция и защита от double booking | NO_DIRECT_PROOF | — |
| EXPERIENCE-X05 | P0 | PHANTOM: idempotency и восстановление | NO_DIRECT_PROOF | — |
| EXPERIENCE-X06 | P0 | PHANTOM: русский booking UX и E2E | NO_DIRECT_PROOF | — |
| EXPERIENCE-X07 | P0 | PHANTOM: админ-панель расписаний и мест | NO_DIRECT_PROOF | — |
| EXPERIENCE-X08 | P0 | STYLO: реальные экспорт/импорт данных | NO_DIRECT_PROOF | — |
| EXPERIENCE-X09 | P0 | STYLO: конфликты версий и rollback | NO_DIRECT_PROOF | — |
| EXPERIENCE-X10 | P0 | STYLO: изоляция нескольких аккаунтов | NO_DIRECT_PROOF | — |
| EXPERIENCE-X11 | P1 | STYLO: гардероб, каталогизация, фильтры | NO_DIRECT_PROOF | — |
| EXPERIENCE-X12 | P1 | STYLO: рекомендации с offline fallback | NO_DIRECT_PROOF | — |
| EXPERIENCE-X13 | P1 | SkillCred: подписанный формат удостоверений | HOLD_SCOPE_EXCLUDED | — |
| EXPERIENCE-X14 | P1 | SkillCred: независимый verifier | HOLD_SCOPE_EXCLUDED | — |
| EXPERIENCE-X15 | P1 | SkillCred: revocation, expiry и key rotation | HOLD_SCOPE_EXCLUDED | — |
| EXPERIENCE-X16 | P1 | SkillCred: privacy, portable credentials и UX | HOLD_SCOPE_EXCLUDED | — |
| EXPERIENCE-X17 | P1 | EchoTrace: pilot schema и data provenance | NO_DIRECT_PROOF | — |
| EXPERIENCE-X18 | P1 | EchoTrace: безопасный ingestion и ACL | NO_DIRECT_PROOF | — |
| EXPERIENCE-X19 | P1 | EchoTrace: тесты качества и false-positive policy | NO_DIRECT_PROOF | — |
| EXPERIENCE-X20 | P1 | EchoTrace: UX отчёта без диагностических заявлений | NO_DIRECT_PROOF | — |
| EXPERIENCE-X21 | P1 | Noor: восстановление исходников и исходных данных | HOLD_SOURCE_MISSING | — |
| EXPERIENCE-X22 | P1 | Noor: курсы, уроки и прогресс | HOLD_SOURCE_MISSING | — |
| EXPERIENCE-X23 | P1 | Noor: подсказки через ограниченный NEXUS API | HOLD_SOURCE_MISSING | — |
| EXPERIENCE-X24 | P1 | Noor: офлайн обучение и проверка прогресса | HOLD_SOURCE_MISSING | — |
| EXPERIENCE-X25 | P1 | CIVIC: deterministic replay и журнал событий | NO_DIRECT_PROOF | — |
| EXPERIENCE-X26 | P2 | CIVIC: инварианты и fault injection | NO_DIRECT_PROOF | — |
| EXPERIENCE-X27 | P2 | CIVIC: визуальный редактор сценариев | NO_DIRECT_PROOF | — |
| EXPERIENCE-X28 | P2 | Единая русская UX-база и локализация | NO_DIRECT_PROOF | — |
| EXPERIENCE-X29 | P2 | Accessibility, mobile/browser и реальные E2E | NO_DIRECT_PROOF | — |
| EXPERIENCE-X30 | P2 | Restore, негативные тесты и release-ready review | NO_DIRECT_PROOF | — |
| GENESIS-X01 | P0 | Гит-baseline и восстановление архитектуры продуктов | NO_DIRECT_PROOF | — |
| GENESIS-X02 | P0 | Версионированная семантическая scene schema | NO_DIRECT_PROOF | — |
| GENESIS-X03 | P0 | Миграции старых сцен и обратимая конвертация | NO_DIRECT_PROOF | — |
| GENESIS-X04 | P0 | 3D редактор: дерево объектов и инспектор | NO_DIRECT_PROOF | — |
| GENESIS-X05 | P0 | 3D редактор: манипуляторы, трансформации, undo | NO_DIRECT_PROOF | — |
| GENESIS-X06 | P0 | 3D редактор: материалы, свет, камеры | NO_DIRECT_PROOF | — |
| GENESIS-X07 | P0 | 3D редактор: события и интерактивное поведение | NO_DIRECT_PROOF | — |
| GENESIS-X08 | P0 | 3D редактор: коллизии и навигация | NO_DIRECT_PROOF | — |
| GENESIS-X09 | P0 | 3D редактор: импорт/экспорт ассетов | NO_DIRECT_PROOF | — |
| GENESIS-X10 | P0 | Безопасные ZIP и filesystem boundaries | NO_DIRECT_PROOF | — |
| GENESIS-X11 | P1 | История проектов и конфликтующие сохранения | NO_DIRECT_PROOF | — |
| GENESIS-X12 | P1 | World Studio: multi-user permissions | NO_DIRECT_PROOF | — |
| GENESIS-X13 | P1 | World Studio: оптимизация 5k+ сцен | NO_DIRECT_PROOF | — |
| GENESIS-X14 | P1 | LOD, culling и streaming ассетов | NO_DIRECT_PROOF | — |
| GENESIS-X15 | P1 | GPU и VRAM профилирование движка | NO_DIRECT_PROOF | — |
| GENESIS-X16 | P1 | Русскоязычный браузерный World Studio E2E | NO_DIRECT_PROOF | — |
| GENESIS-X17 | P1 | CineVault: индекс ассетов и метаданных | NO_DIRECT_PROOF | — |
| GENESIS-X18 | P1 | CineVault: поиск, теги и provenance | NO_DIRECT_PROOF | — |
| GENESIS-X19 | P1 | CINEOS: монтажные таймлайны и EDL | NO_DIRECT_PROOF | — |
| GENESIS-X20 | P1 | Video Forge: FFmpeg pipeline integration | NO_DIRECT_PROOF | — |
| GENESIS-X21 | P1 | Видео QC: ffprobe, decode, integrity receipt | NO_DIRECT_PROOF | — |
| GENESIS-X22 | P1 | Версионирование источников и лицензий контента | NO_DIRECT_PROOF | — |
| GENESIS-X23 | P1 | Cinema: durable job queue и worker leases | NO_DIRECT_PROOF | — |
| GENESIS-X24 | P1 | Cinema: отмена, повторы и crash recovery | NO_DIRECT_PROOF | — |
| GENESIS-X25 | P1 | Ресурсный admission-контракт TITAN | NO_DIRECT_PROOF | — |
| GENESIS-X26 | P2 | AI-adapter NEXUS с измеренными ограничениями | NO_DIRECT_PROOF | — |
| GENESIS-X27 | P2 | Очереди CPU/GPU без взаимного starvation | NO_DIRECT_PROOF | — |
| GENESIS-X28 | P2 | Бенчмарки кодеков и аппаратной совместимости | NO_DIRECT_PROOF | — |
| GENESIS-X29 | P2 | Безопасность загрузок и медиапесочница | NO_DIRECT_PROOF | — |
| GENESIS-X30 | P2 | Полный сценарий scene→render→QC→export | NO_DIRECT_PROOF | — |
| ORBITAL-X01 | P0 | Исходный baseline и разделение research/production | NO_DIRECT_PROOF | — |
| ORBITAL-X02 | P0 | Определить threat model канала и ledger | NO_DIRECT_PROOF | — |
| ORBITAL-X03 | P0 | Формат версионированного command envelope | NO_DIRECT_PROOF | — |
| ORBITAL-X04 | P0 | Проверка identity терминала в sandbox | NO_DIRECT_PROOF | — |
| ORBITAL-X05 | P0 | Аутентификация команд и подтверждений ACK | NO_DIRECT_PROOF | — |
| ORBITAL-X06 | P0 | TTL, nonce и устойчивый replay register | NO_DIRECT_PROOF | — |
| ORBITAL-X07 | P0 | Отделение transport ACK от execution ACK | NO_DIRECT_PROOF | — |
| ORBITAL-X08 | P0 | Durable queue, outbox и транзакционная запись | NO_DIRECT_PROOF | — |
| ORBITAL-X09 | P0 | Idempotency, fencing и конкурентные receivers | NO_DIRECT_PROOF | — |
| ORBITAL-X10 | P0 | Virtual-time transport simulator | NO_DIRECT_PROOF | — |
| ORBITAL-X11 | P1 | Loss, duplication и out-of-order delivery | NO_DIRECT_PROOF | — |
| ORBITAL-X12 | P1 | Partition, disconnect и delayed ACK | NO_DIRECT_PROOF | — |
| ORBITAL-X13 | P1 | Bandwidth, byte budget, cost model | NO_DIRECT_PROOF | — |
| ORBITAL-X14 | P1 | Seeded reproducible scenario suite | NO_DIRECT_PROOF | — |
| ORBITAL-X15 | P1 | Crash/restart/corruption transport tests | NO_DIRECT_PROOF | — |
| ORBITAL-X16 | P1 | Модель provider API без реального подключения | NO_DIRECT_PROOF | — |
| ORBITAL-X17 | P1 | Тесты устойчивости под высокой нагрузкой | NO_DIRECT_PROOF | — |
| ORBITAL-X18 | P1 | Контракт command authorization с NEXUS/TITAN | NO_DIRECT_PROOF | — |
| ORBITAL-X19 | P1 | Ledger: сравнительная архитектурная оценка | NO_DIRECT_PROOF | — |
| ORBITAL-X20 | P1 | Ledger: документирование доверенных сторон | NO_DIRECT_PROOF | — |
| ORBITAL-X21 | P1 | Ledger: баланс и nonce state machine | NO_DIRECT_PROOF | — |
| ORBITAL-X22 | P1 | Ledger: инварианты и property-based tests | NO_DIRECT_PROOF | — |
| ORBITAL-X23 | P1 | Ledger: fault injection и проверка хранения | NO_DIRECT_PROOF | — |
| ORBITAL-X24 | P1 | Ledger: изолированная модель валидаторов | NO_DIRECT_PROOF | — |
| ORBITAL-X25 | P1 | Ledger: BFT failure and partition experiments | NO_DIRECT_PROOF | — |
| ORBITAL-X26 | P2 | Ledger: конфликты веток и модель финальности | NO_DIRECT_PROOF | — |
| ORBITAL-X27 | P2 | Ledger: криптографические ключи в тестовой модели | NO_DIRECT_PROOF | — |
| ORBITAL-X28 | P2 | Ledger: экономические допущения и затраты | NO_DIRECT_PROOF | — |
| ORBITAL-X29 | P2 | Ledger: независимая проверка и audit report | NO_DIRECT_PROOF | — |
| ORBITAL-X30 | P2 | Решение research GO/NO-GO по доказательствам | NO_DIRECT_PROOF | — |

Исторический INITIAL_AUDIT_180 сохранён. Реестр фиксирует только наличие связанного кода, не выполнение оригинального задания. Main и production не менялись.
