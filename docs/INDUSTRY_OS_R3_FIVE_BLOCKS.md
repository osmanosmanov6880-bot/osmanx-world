# OSMANX INDUSTRY OS R3 — 5 engineering blocks

## Реализованные блоки
1. PostgreSQL 16: таблицы tenants/accounts/memberships, services, customers, resources, appointments, audit/outbox, строгая RLS-изоляция, FK с tenant_id и ограничение пересекающихся записей.
2. Безопасный вход: scrypt-пароли, случайные HttpOnly-сессии, CSRF, проверка Origin, ограничение попыток, роли owner/manager/operator/viewer, отсутствие публичной регистрации.
3. Серверная CRM и запись: создание и просмотр клиентов, услуг, ресурсов и визитов, проверка переходов статусов, защита от двойной записи и повторных POST через Idempotency-Key.
4. Очередь интеграций: транзакционный outbox, отдельный worker, HMAC-SHA256, экспоненциальные повторы, dead-letter для неудачных отправок; отправка только на операторский HTTPS endpoint.
5. Панель оператора: /assets/industry/console.html, вход и действия через настоящий API, без подмены реальных данных браузерным демо; тесты PostgreSQL и Chromium.

## Точная граница публикации
Текущий osmanx.world содержит статический портал, поэтому GitHub push публикует HTML/CSS/JS кабинета, но НЕ запускает Node и PostgreSQL на VPS.
Для реального входа инфраструктурный администратор должен настроить отдельный сервер и маршрутизацию /api/industry/v1/ на http://127.0.0.1:3047/api/industry/v1/ через HTTPS домена osmanx.world.
Для production нужны отдельные DB-роли и секреты, защищённая сеть, журналы, резервное копирование, восстановление, технический и правовой аудит обработки персональных данных.
Нельзя загружать реальные медицинские данные в локальный демо-режим. Реальные медицинские API не подключены.

## Установка в изолированной серверной среде
Node >=22 и PostgreSQL >=16. Каталог: services/industry-api. npm install --ignore-scripts; npm run migrate; npm run bootstrap; npm start.
Миграции выполняются только через MIGRATION_DB_URL с повышенными правами, а HTTP API получает DATABASE_URL ограниченной роли industry_app с NOBYPASSRLS.
Создайте роли industry_app LOGIN NOBYPASSRLS и industry_worker LOGIN BYPASSRLS с индивидуальными секретами; секреты в среде исполнения или защищённом секрет-хранилище, не в репозитории.
Перед bootstrap нужны BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD (не менее 12 символов), BOOTSTRAP_TENANT_SLUG, BOOTSTRAP_TENANT_NAME, BOOTSTRAP_VERTICAL и MIGRATION_DB_URL.
Сервер работает с NODE_ENV=production, ALLOWED_ORIGIN=https://osmanx.world, BIND_HOST=127.0.0.1 и PORT=3047.
Для worker нужны WORKER_DB_URL, WEBHOOK_URL и WEBHOOK_HMAC_KEY длиной от 32 символов. По умолчанию внешние интеграции выключены.

## API
GET /api/industry/v1/health/live, /health/ready, /auth/me, /dashboard, /customers, /services, /resources, /appointments, /audit.
POST /auth/login, /auth/logout, /customers, /services, /resources, /appointments.
PATCH /appointments/:id/status.
Все маршруты CRM требуют авторизации. Сессия привязана к единственной компании, чтение из других компаний блокируется RLS.

## Тестирование
industry-api-ci.yml запускает PostgreSQL 16, миграции дважды, Node тесты аутентификации, CSRF, RLS, ролей, конфликтов бронирования, идемпотентности и HMAC-доставки.
industry-browser.yml проверяет клиентские демо, а также честное отображение отсутствующего API в новом кабинете.
deploy.yml проверяет новые статические файлы; не имеет привилегий управления systemd, nginx или базами данных.

## Вне этого релиза
Развёрнутый backend на VPS, медицинские МИС/ЛИС, платежи, приглашения сотрудников, пароли по email, нативные Android/iOS сборки, восстановление backup в production.
