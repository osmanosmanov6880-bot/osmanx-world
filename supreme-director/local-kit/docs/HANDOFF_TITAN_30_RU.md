# M182 — задание TITAN / KRAKEN

**Предлагаемый инженерный маршрут из 30 задач; это НЕ оригинальные 30 задач M181.**
Оригинальные ID и 294 зависимости могут быть связаны только после сверки SHA-pinned ZIP и upstream Git.

Фокус: защищённое исполнение задач, очереди и sandbox. Критический риск: изоляция исполняемого кода и межпроцессные полномочия.

| ID | Блок | Задание | Приёмочное доказательство |
|---|---|---|---|
| `M182-TITAN-A01` | A | Привязать канонический upstream Git commit, владельца и ветку | Ссылка на репозиторий; read-only Git SHA; владелец подтверждает соответствие продукта |
| `M182-TITAN-A02` | A | Подтвердить происхождение M181, задачу и исходные зависимости | Original source ZIP+SHA, task crosswalk, конкретный оригинальный ID |
| `M182-TITAN-B01` | B | Назначить CODEOWNERS и read-only ACL карту | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-TITAN-B02` | B | Проверить SSO/IAM/RBAC для доменного контура | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-TITAN-B03` | B | Зафиксировать secrets, keys и принцип минимальных прав | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-TITAN-B04` | B | Составить SBOM/лицензии, запретить неподтверждённые зависимости | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-TITAN-B05` | B | Зафиксировать boundary sandbox/network/tenants | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-TITAN-B06` | B | Утвердить immutable schema и версионирование API | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-TITAN-B07` | B | Подготовить безопасные миграции и rollback | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-TITAN-B08` | B | Определить negative security tests и evidence retention | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-TITAN-C01` | C | Ревизия immutable job queue и границ задач | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-TITAN-C02` | C | Восстановление worker lease/fencing по exact commit | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-TITAN-C03` | C | RBAC для постановки, отмены и просмотра задач | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-TITAN-C04` | C | Негативные tenant isolation тесты на уровне task API | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-TITAN-C05` | C | Docker sandbox без host mounts и неявных pull | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-TITAN-C06` | C | Карантин хоста при неподтверждённом cleanup | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-TITAN-C07` | C | Ограничения CPU/RAM/time и безопасное прерывание | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-TITAN-C08` | C | Идемпотентная обработка повторно доставленного задания | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-TITAN-C09` | C | Неподменяемый execution log и provenance artifacts | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-TITAN-C10` | C | Защита состояния очереди после crash и reboot | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-TITAN-C11` | C | Cross-service API с NEXUS/ÆTHERION | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-TITAN-C12` | C | Обработка untrusted code без escape и секретов | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-TITAN-C13` | C | Наблюдаемость worker health и аварийных переходов | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-TITAN-C14` | C | Staging E2E создание→исполнение→отмена→аудит | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-TITAN-C15` | C | Независимое ревью runtime и sandbox boundary | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-TITAN-D01` | D | Выполнить source-pinned интеграционный E2E в staging | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-TITAN-D02` | D | Получить независимое security+CODEOWNERS review без саморевью | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-TITAN-D03` | D | Провести backup/restore и rollback rehearsal на реальном окружении | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-TITAN-D04` | D | Измерить latency, error budget, alerts и on-call готовность | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-TITAN-D05` | D | Зафиксировать отдельное owner GO/NO-GO с полным реестром доказательств | Подписанные независимые доказательства; без подмены local PASS на production GO |

## Запреты

- Нельзя утверждать original task DONE без настоящего исходного ID, commit SHA и внешнего reviewer.
- Нельзя импортировать кэши, локальные SQLite или шрифты STYLO без лицензий.
- Нельзя сливать межкомандные файлы по дате или только по хешу; требуется review обоих вариантов.
- Любая попытка production deploy блокируется до подписанного независимого owner GO.
