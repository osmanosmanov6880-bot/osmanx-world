# M182 — задание ORBITAL

**Предлагаемый инженерный маршрут из 30 задач; это НЕ оригинальные 30 задач M181.**
Оригинальные ID и 294 зависимости могут быть связаны только после сверки SHA-pinned ZIP и upstream Git.

Фокус: исследования, метрики и доказательства решений. Критический риск: подлинность источников, воспроизводимость и независимые решения.

| ID | Блок | Задание | Приёмочное доказательство |
|---|---|---|---|
| `M182-ORBITAL-A01` | A | Привязать канонический upstream Git commit, владельца и ветку | Ссылка на репозиторий; read-only Git SHA; владелец подтверждает соответствие продукта |
| `M182-ORBITAL-A02` | A | Подтвердить происхождение M181, задачу и исходные зависимости | Original source ZIP+SHA, task crosswalk, конкретный оригинальный ID |
| `M182-ORBITAL-B01` | B | Назначить CODEOWNERS и read-only ACL карту | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-ORBITAL-B02` | B | Проверить SSO/IAM/RBAC для доменного контура | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-ORBITAL-B03` | B | Зафиксировать secrets, keys и принцип минимальных прав | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-ORBITAL-B04` | B | Составить SBOM/лицензии, запретить неподтверждённые зависимости | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-ORBITAL-B05` | B | Зафиксировать boundary sandbox/network/tenants | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-ORBITAL-B06` | B | Утвердить immutable schema и версионирование API | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-ORBITAL-B07` | B | Подготовить безопасные миграции и rollback | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-ORBITAL-B08` | B | Определить negative security tests и evidence retention | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-ORBITAL-C01` | C | Реестр исследовательских гипотез и источников | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-ORBITAL-C02` | C | Разделение симуляции и production фактов | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-ORBITAL-C03` | C | Детерминированное воспроизведение расчётов | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-ORBITAL-C04` | C | Контроль целостности ledger исследовательских фактов | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-ORBITAL-C05` | C | Сведение экономических допущений и uncertainty | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-ORBITAL-C06` | C | Негативные тесты stale и manipulated evidence | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-ORBITAL-C07` | C | Identity/authorization голосований и подписей | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-ORBITAL-C08` | C | Защита от replay/double-count в vote evidence | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-ORBITAL-C09` | C | Сравнение результатов экспериментов по версиям | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-ORBITAL-C10` | C | Observability для источников/датасетов | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-ORBITAL-C11` | C | Контракт событий COMMERCE→ORBITAL | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-ORBITAL-C12` | C | Контракт model metrics NEXUS→ORBITAL | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-ORBITAL-C13` | C | Audit trail с signed checkpoints | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-ORBITAL-C14` | C | E2E research→review→decision без auto-GO | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-ORBITAL-C15` | C | Независимое scientific/economic/security review | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-ORBITAL-D01` | D | Выполнить source-pinned интеграционный E2E в staging | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-ORBITAL-D02` | D | Получить независимое security+CODEOWNERS review без саморевью | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-ORBITAL-D03` | D | Провести backup/restore и rollback rehearsal на реальном окружении | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-ORBITAL-D04` | D | Измерить latency, error budget, alerts и on-call готовность | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-ORBITAL-D05` | D | Зафиксировать отдельное owner GO/NO-GO с полным реестром доказательств | Подписанные независимые доказательства; без подмены local PASS на production GO |

## Запреты

- Нельзя утверждать original task DONE без настоящего исходного ID, commit SHA и внешнего reviewer.
- Нельзя импортировать кэши, локальные SQLite или шрифты STYLO без лицензий.
- Нельзя сливать межкомандные файлы по дате или только по хешу; требуется review обоих вариантов.
- Любая попытка production deploy блокируется до подписанного независимого owner GO.
