# OSMANX Industry OS R4 — пять инженерных блоков

## 1. Проверенная граница текущего VPS
На 17 ноября 2026 года диагностика существующего VPS установила: у пользователя деплоя deploy-osmanx есть доступ на запись к /var/www/osmanx.world, но нет Node.js, npm, Docker, Podman или passwordless sudo. Nginx и PostgreSQL работают, но рабочий API и разрешения на системную настройку отсутствуют.
Поэтому пуш в main публикует ТОЛЬКО HTML/CSS/JS. Никакая часть этого релиза не начинает работу с персональными данными до отдельной инфраструктурной подготовки администратором. Исходные пять (после изменений — шесть) проектов портала не заменяются.

## 2. Пять завершённых блоков кода
**B1 — Runtime:** отдельный Dockerfile Node 22 non-root, Compose с приватной PostgreSQL 16, одноразовым provision, миграцией, bootstrap, API на 127.0.0.1:3047, опциональным worker, готовой вставкой в существующий Nginx и read-only runtime preflight.
**B2 — Disaster Recovery:** pg_dump custom архива industry, шифрование age двумя независимыми получателями, SHA-256 файл, проверка двух независимых ключей на отдельных industry_dr_* БД, запрет возврата в production и проверка порчи архива. Отдельный maintenance image / Compose profile.
**B3 — Команда:** 48-часовые однократные приглашения на 256-битных токенах, нераскрываемые в БД токены, управление ролями и отзыв сессий. Владелец не может потерять владельческие права при обычном удалении сотрудника.
**B4 — Расписание:** график по дням недели, IANA timezone, исключение перерывов, слоты с шагом 30 минут, безопасный перенос, блокировка двойных записей на уровне PostgreSQL и резервирование ресурса в транзакции.
**B5 — Интеграции:** статус очереди по компаниям, просмотр событий без полезной нагрузки с клиентскими данными, ручной перезапуск dead-letter, атомарные lease-токены обработчиков, HMAC-SHA256 и повторная обработка.

## 3. Публикация и безопасный запуск
Обновление обычного сайта через workflow deploy.yml не устанавливает PostgreSQL, Docker, Nginx или системные сервисы. Код API размещается в services/industry-api/, а клиентские страницы — в assets/industry/.
Только уполномоченный администратор VPS должен:
1. Выделить отдельный каталог /srv/osmanx-industry (НЕ внутри /var/www/osmanx.world), рабочую учётную запись и установить Docker Engine с Compose.
2. Проверить services/industry-api/ops/runtime-check.sh и всю конфигурацию compose.yml.
3. Сохранить services/industry-api/ops/.env.example как .env в приватном каталоге, назначить chmod 600 и заменить все шаблонные секреты случайными значениями (например openssl rand -hex 32). Ни один секрет не коммитить.
4. Запустить из services/industry-api: docker compose up -d db
5. Выполнить docker compose --profile setup run --rm provision
6. Выполнить docker compose --profile setup run --rm migrate
7. Выполнить docker compose --profile setup run --rm bootstrap
8. Выполнить docker compose up -d api и проверить curl -fsS http://127.0.0.1:3047/api/industry/v1/health/ready
9. После отдельной проверки Nginx включить конфигурацию из ops/nginx-industry.conf внутри существующего HTTPS server block, проверить nginx -t и выполнить штатную перезагрузку. Затем проверить https://osmanx.world/api/industry/v1/health/ready.
10. Подключать опциональный worker через docker compose --profile integrations up -d worker ТОЛЬКО после настройки доверенного HTTPS-приёмника и валидации HMAC-подписи.

Обратите внимание: provision-roles.sh требует минимум 32 символа для паролей ролей и принимает только безопасные URL-символы; удобнее использовать hex-строки длиной 64. Скрипт bootstrap создаёт исходного владельца и календарь, не печатая пароль.

## 4. Зашифрованные резервные копии
Создайте два независимых приватных age-ключа ВНЕ репозитория и храните их отдельно. В .env укажите только их ПУБЛИЧНЫЕ ключи как AGE_RECIPIENT_1 и AGE_RECIPIENT_2.
Приватные идентичности нельзя сохранять в GitHub, публичном веб-каталоге или переписке.
Для контейнерного резервирования администратор создаёт каталог services/industry-api/backups с правом записи для UID postgres внутри контейнера (обычно 999), chmod 700 и затем выполняет docker compose --profile backup run --rm backup.
Архивы должны переноситься в отдельное защищённое хранилище по утверждённой политике сохранности и доступа, а не оставаться только на этом же сервере. Создание файла само по себе не является DR.
Для теста восстановления создаётся ПУСТАЯ БД с именем industry_dr_*, затем в контейнер dr монтируется приватный age ключ в /run/age-keys/identity.txt; целевая DR_RESTORE_DB_URL должна указывать на DR-базу, а не production.
Скрипт ops/restore-dr.sh проверяет SHA-256, запрещает непустую industry-схему и отказывается восстанавливать в базу без префикса industry_dr_.

## 5. Новые API
GET /api/industry/v1/staff; POST /staff/invitations, /staff/invitations/accept, /staff/invitations/:id/revoke; PATCH /staff/:accountId; DELETE /staff/:accountId.
GET /api/industry/v1/settings/timezone; PATCH /settings/timezone; GET,PUT /resources/:id/hours; POST /resources/:id/time-off; DELETE /resources/:id/time-off/:offId; GET /availability; PATCH /appointments/:id/reschedule.
GET /api/industry/v1/integrations/status; GET /integrations/events; POST /integrations/events/:id/retry.
Права доступа, RLS и ограничения PostgreSQL обязательны; запросы в тестах выполняются на разных tenant-аккаунтах.

## 6. Реальные ограничения
Система не интегрирована с МИС/ЛИС, YCLIENTS, iiko, кассовыми и платёжными сервисами. Нет подтверждённого production-развёртывания API. Нет медицинской сертификации, оценки законности хранения пациентских данных, внешнего пентеста или нативного мобильного приложения. Не загружайте реальные данные в публичный R2-демо.

## 7. Проверки
- .github/workflows/industry-api-ci.yml — PostgreSQL 16, миграции, RLS, приглашения, расписание, Webhook и проверка tenant isolation.
- .github/workflows/industry-dr-ci.yml — два независимых age-ключа, восстановление обеих копий, запрет production-restore, проверка sha256, Docker Compose и nonroot-контейнеров.
- .github/workflows/industry-browser.yml — мобильная и десктопная визуальная приёмка и подтверждение, что статический кабинет честно отображает отсутствие backend.
- .github/workflows/deploy.yml — только доставка статических файлов; после merge проверка публичного HTTPS.
