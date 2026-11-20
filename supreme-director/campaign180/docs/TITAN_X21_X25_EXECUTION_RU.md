# TITAN-X21-X25 — локальный инженерный пакет

Дата: 2026-11-16. План: `supreme-director/originals/DIRECTOR_MASTER_180.md`.
Базовый Git SHA: `180aa4d9c4073430139100b41c3674adb053d0f6`.
Draft PR #7; основная ветка и production не изменяются.

## Реализация

- **X21:** атомарная запись из model-backed form, точная ревизия, whitelist полей, связи и durable idempotency, только local authenticated API.
- **X22:** inspection без записей, CAS-замена правила, immutable audit; run idempotency привязана к SHA правила.
- **X23:** owner-only перечень ролей и отзывов доступа без передачи actor/tenant через запрос.
- **X24:** хешированное сравнение исторических ревизий без экспортирования клиентских записей.
- **X25:** воспроизводимый offline staging-кандидат с повторной проверкой сгенерированного ZIP и SHA-256, без публикации.

## Проверки

`tests/test_titan_x21_x25.py`: тесты ошибок, транзакций, concurrency, идемпотентности, tenant/RBAC, ревизий и WSGI API.
`.github/workflows/titan-original-x21-x25.yml`: Python 3.11/3.13 и существующие регрессии.
Сам факт записи кода не означает PASS, статусы берутся из GitHub Actions.

## Ограничения и rollback

Статическая веб-форма в preview намеренно отключена; запись доступна только через bearer-authenticated local API.
Нет публичного staging, deploy, платежей, сети, независимой подписи или owner-approved SHA KRAKEN/DevSwarm/Command.
Для оригинальных X21-X25 статус **LOCAL_CODE / BLOCKED_UPSTREAM**, а не DONE.
Откат — revert коммита пакета; историю SQLite и данные сначала сохранить и проверить, не удалять использованные таблицы без резервной копии.
