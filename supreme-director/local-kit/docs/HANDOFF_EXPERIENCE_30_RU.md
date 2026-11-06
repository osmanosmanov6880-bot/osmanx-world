# M182 — задание HUMAN EXPERIENCE

**Предлагаемый инженерный маршрут из 30 задач; это НЕ оригинальные 30 задач M181.**
Оригинальные ID и 294 зависимости могут быть связаны только после сверки SHA-pinned ZIP и upstream Git.

Фокус: пользовательский опыт, права доступа и локализация. Критический риск: пользовательские данные, доступность и согласия.

| ID | Блок | Задание | Приёмочное доказательство |
|---|---|---|---|
| `M182-EXPERIENCE-A01` | A | Привязать канонический upstream Git commit, владельца и ветку | Ссылка на репозиторий; read-only Git SHA; владелец подтверждает соответствие продукта |
| `M182-EXPERIENCE-A02` | A | Подтвердить происхождение M181, задачу и исходные зависимости | Original source ZIP+SHA, task crosswalk, конкретный оригинальный ID |
| `M182-EXPERIENCE-B01` | B | Назначить CODEOWNERS и read-only ACL карту | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-EXPERIENCE-B02` | B | Проверить SSO/IAM/RBAC для доменного контура | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-EXPERIENCE-B03` | B | Зафиксировать secrets, keys и принцип минимальных прав | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-EXPERIENCE-B04` | B | Составить SBOM/лицензии, запретить неподтверждённые зависимости | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-EXPERIENCE-B05` | B | Зафиксировать boundary sandbox/network/tenants | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-EXPERIENCE-B06` | B | Утвердить immutable schema и версионирование API | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-EXPERIENCE-B07` | B | Подготовить безопасные миграции и rollback | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-EXPERIENCE-B08` | B | Определить negative security tests и evidence retention | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-EXPERIENCE-C01` | C | Матрица ролей UX и access denial | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-EXPERIENCE-C02` | C | Защищённый session lifecycle и logout | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-EXPERIENCE-C03` | C | Проверка consent/privacy UI | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-EXPERIENCE-C04` | C | RU/EN и устойчивость длинных строк | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-EXPERIENCE-C05` | C | Keyboard/screen-reader основные сценарии | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-EXPERIENCE-C06` | C | Fallback для offline и медленной сети | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-EXPERIENCE-C07` | C | Error boundary для недоступных интеграций | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-EXPERIENCE-C08` | C | Отказ по оплате без ложной выдачи entitlement | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-EXPERIENCE-C09` | C | End-to-end прохождение регистрации и входа | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-EXPERIENCE-C10` | C | Изоляция профилей разных пользователей | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-EXPERIENCE-C11` | C | Контракт разрешений с COMMERCE | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-EXPERIENCE-C12` | C | Контракт контента с GENESIS MEDIA | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-EXPERIENCE-C13` | C | Telemetry без PII и с opt-out | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-EXPERIENCE-C14` | C | Визуальная приёмка на реальных desktop/mobile устройствах | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-EXPERIENCE-C15` | C | Независимое UX/accessibility/privacy review | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-EXPERIENCE-D01` | D | Выполнить source-pinned интеграционный E2E в staging | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-EXPERIENCE-D02` | D | Получить независимое security+CODEOWNERS review без саморевью | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-EXPERIENCE-D03` | D | Провести backup/restore и rollback rehearsal на реальном окружении | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-EXPERIENCE-D04` | D | Измерить latency, error budget, alerts и on-call готовность | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-EXPERIENCE-D05` | D | Зафиксировать отдельное owner GO/NO-GO с полным реестром доказательств | Подписанные независимые доказательства; без подмены local PASS на production GO |

## Запреты

- Нельзя утверждать original task DONE без настоящего исходного ID, commit SHA и внешнего reviewer.
- Нельзя импортировать кэши, локальные SQLite или шрифты STYLO без лицензий.
- Нельзя сливать межкомандные файлы по дате или только по хешу; требуется review обоих вариантов.
- Любая попытка production deploy блокируется до подписанного независимого owner GO.
