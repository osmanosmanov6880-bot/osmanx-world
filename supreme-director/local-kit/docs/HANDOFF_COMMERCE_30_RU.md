# M182 — задание COMMERCE

**Предлагаемый инженерный маршрут из 30 задач; это НЕ оригинальные 30 задач M181.**
Оригинальные ID и 294 зависимости могут быть связаны только после сверки SHA-pinned ZIP и upstream Git.

Фокус: заказы, биллинг и контроль денежных состояний. Критический риск: платежные записи, идемпотентность и авторизация денежных действий.

| ID | Блок | Задание | Приёмочное доказательство |
|---|---|---|---|
| `M182-COMMERCE-A01` | A | Привязать канонический upstream Git commit, владельца и ветку | Ссылка на репозиторий; read-only Git SHA; владелец подтверждает соответствие продукта |
| `M182-COMMERCE-A02` | A | Подтвердить происхождение M181, задачу и исходные зависимости | Original source ZIP+SHA, task crosswalk, конкретный оригинальный ID |
| `M182-COMMERCE-B01` | B | Назначить CODEOWNERS и read-only ACL карту | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-COMMERCE-B02` | B | Проверить SSO/IAM/RBAC для доменного контура | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-COMMERCE-B03` | B | Зафиксировать secrets, keys и принцип минимальных прав | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-COMMERCE-B04` | B | Составить SBOM/лицензии, запретить неподтверждённые зависимости | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-COMMERCE-B05` | B | Зафиксировать boundary sandbox/network/tenants | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-COMMERCE-B06` | B | Утвердить immutable schema и версионирование API | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-COMMERCE-B07` | B | Подготовить безопасные миграции и rollback | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-COMMERCE-B08` | B | Определить negative security tests и evidence retention | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-COMMERCE-C01` | C | Контракт заказа с неизменяемыми identifiers | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-COMMERCE-C02` | C | Idempotency key для create/charge/refund | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-COMMERCE-C03` | C | Верификация подписей и replay window webhook | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-COMMERCE-C04` | C | Transactional outbox и retry семантика | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-COMMERCE-C05` | C | Согласованность ledger и external provider states | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-COMMERCE-C06` | C | Безопасная миграция схемы заказов | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-COMMERCE-C07` | C | Разделение финансовых/административных ролей | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-COMMERCE-C08` | C | PCI/privacy scope и запрет логирования PAN/секретов | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-COMMERCE-C09` | C | Staging provider sandbox без реальных списаний | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-COMMERCE-C10` | C | Reconciliation разногласий event и ledger | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-COMMERCE-C11` | C | Контракт purchase entitlement с EXPERIENCE | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-COMMERCE-C12` | C | Контракт платежного события для ORBITAL analytics | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-COMMERCE-C13` | C | Нагрузочные и отказные сценарии duplicate webhook | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-COMMERCE-C14` | C | E2E create→pay→refund→receipt в тестовом окружении | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-COMMERCE-C15` | C | Независимое security/finance review | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-COMMERCE-D01` | D | Выполнить source-pinned интеграционный E2E в staging | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-COMMERCE-D02` | D | Получить независимое security+CODEOWNERS review без саморевью | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-COMMERCE-D03` | D | Провести backup/restore и rollback rehearsal на реальном окружении | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-COMMERCE-D04` | D | Измерить latency, error budget, alerts и on-call готовность | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-COMMERCE-D05` | D | Зафиксировать отдельное owner GO/NO-GO с полным реестром доказательств | Подписанные независимые доказательства; без подмены local PASS на production GO |

## Запреты

- Нельзя утверждать original task DONE без настоящего исходного ID, commit SHA и внешнего reviewer.
- Нельзя импортировать кэши, локальные SQLite или шрифты STYLO без лицензий.
- Нельзя сливать межкомандные файлы по дате или только по хешу; требуется review обоих вариантов.
- Любая попытка production deploy блокируется до подписанного независимого owner GO.
