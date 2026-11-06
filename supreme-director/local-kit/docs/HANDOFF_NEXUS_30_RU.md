# M182 — задание NEXUS / ÆTHERION

**Предлагаемый инженерный маршрут из 30 задач; это НЕ оригинальные 30 задач M181.**
Оригинальные ID и 294 зависимости могут быть связаны только после сверки SHA-pinned ZIP и upstream Git.

Фокус: модели, агентные задания и доступ к инструментам. Критический риск: границы tool calls, prompt injection и tenant data.

| ID | Блок | Задание | Приёмочное доказательство |
|---|---|---|---|
| `M182-NEXUS-A01` | A | Привязать канонический upstream Git commit, владельца и ветку | Ссылка на репозиторий; read-only Git SHA; владелец подтверждает соответствие продукта |
| `M182-NEXUS-A02` | A | Подтвердить происхождение M181, задачу и исходные зависимости | Original source ZIP+SHA, task crosswalk, конкретный оригинальный ID |
| `M182-NEXUS-B01` | B | Назначить CODEOWNERS и read-only ACL карту | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-NEXUS-B02` | B | Проверить SSO/IAM/RBAC для доменного контура | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-NEXUS-B03` | B | Зафиксировать secrets, keys и принцип минимальных прав | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-NEXUS-B04` | B | Составить SBOM/лицензии, запретить неподтверждённые зависимости | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-NEXUS-B05` | B | Зафиксировать boundary sandbox/network/tenants | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-NEXUS-B06` | B | Утвердить immutable schema и версионирование API | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-NEXUS-B07` | B | Подготовить безопасные миграции и rollback | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-NEXUS-B08` | B | Определить negative security tests и evidence retention | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-NEXUS-C01` | C | Инвентаризация model/provider adapters и API версий | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-NEXUS-C02` | C | Отдельные tenant-scoped agent sessions | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-NEXUS-C03` | C | Проверка permission scopes всех инструментов | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-NEXUS-C04` | C | Ограничение бюджета токенов и rate limits | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-NEXUS-C05` | C | Prompt injection boundaries для retrieved content | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-NEXUS-C06` | C | Deny-by-default при отказе provider/auth | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-NEXUS-C07` | C | Версионирование prompt/template с происхождением | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-NEXUS-C08` | C | Трассировка tool invocations без записи секретов | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-NEXUS-C09` | C | Staging с synthetic model failures и timeouts | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-NEXUS-C10` | C | Подпись, TTL и ревокация agent grants | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-NEXUS-C11` | C | Контракт очереди TITAN job→agent task | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-NEXUS-C12` | C | Контракт медиа-выхода GENESIS с лицензией | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-NEXUS-C13` | C | Data retention, erasure и privacy gate | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-NEXUS-C14` | C | E2E от запросов до проверяемого конечного результата | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-NEXUS-C15` | C | Независимое ревью модели угрозы и источников | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-NEXUS-D01` | D | Выполнить source-pinned интеграционный E2E в staging | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-NEXUS-D02` | D | Получить независимое security+CODEOWNERS review без саморевью | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-NEXUS-D03` | D | Провести backup/restore и rollback rehearsal на реальном окружении | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-NEXUS-D04` | D | Измерить latency, error budget, alerts и on-call готовность | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-NEXUS-D05` | D | Зафиксировать отдельное owner GO/NO-GO с полным реестром доказательств | Подписанные независимые доказательства; без подмены local PASS на production GO |

## Запреты

- Нельзя утверждать original task DONE без настоящего исходного ID, commit SHA и внешнего reviewer.
- Нельзя импортировать кэши, локальные SQLite или шрифты STYLO без лицензий.
- Нельзя сливать межкомандные файлы по дате или только по хешу; требуется review обоих вариантов.
- Любая попытка production deploy блокируется до подписанного независимого owner GO.
