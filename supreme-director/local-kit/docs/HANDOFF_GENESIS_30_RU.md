# M182 — задание GENESIS MEDIA

**Предлагаемый инженерный маршрут из 30 задач; это НЕ оригинальные 30 задач M181.**
Оригинальные ID и 294 зависимости могут быть связаны только после сверки SHA-pinned ZIP и upstream Git.

Фокус: производство медиа, происхождение и права использования. Критический риск: лицензии, вредоносные входные файлы и доступ к медиа.

| ID | Блок | Задание | Приёмочное доказательство |
|---|---|---|---|
| `M182-GENESIS-A01` | A | Привязать канонический upstream Git commit, владельца и ветку | Ссылка на репозиторий; read-only Git SHA; владелец подтверждает соответствие продукта |
| `M182-GENESIS-A02` | A | Подтвердить происхождение M181, задачу и исходные зависимости | Original source ZIP+SHA, task crosswalk, конкретный оригинальный ID |
| `M182-GENESIS-B01` | B | Назначить CODEOWNERS и read-only ACL карту | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-GENESIS-B02` | B | Проверить SSO/IAM/RBAC для доменного контура | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-GENESIS-B03` | B | Зафиксировать secrets, keys и принцип минимальных прав | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-GENESIS-B04` | B | Составить SBOM/лицензии, запретить неподтверждённые зависимости | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-GENESIS-B05` | B | Зафиксировать boundary sandbox/network/tenants | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-GENESIS-B06` | B | Утвердить immutable schema и версионирование API | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-GENESIS-B07` | B | Подготовить безопасные миграции и rollback | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-GENESIS-B08` | B | Определить negative security tests и evidence retention | Проверенная модель угроз, CI negative case и два раздельных reviewer evidence |
| `M182-GENESIS-C01` | C | Реестр медиа-активов с лицензиями | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-GENESIS-C02` | C | SHA-проверка входных asset bytes | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-GENESIS-C03` | C | Безопасная загрузка/сканирование форматов | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-GENESIS-C04` | C | Изоляция media worker и лимиты ресурса | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-GENESIS-C05` | C | Очередь transcode/generate с retry и cancel | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-GENESIS-C06` | C | Проверка авторских прав и brand approvals | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-GENESIS-C07` | C | Ротация signed media URLs и access tokens | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-GENESIS-C08` | C | Контроль CDN cache invalidation | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-GENESIS-C09` | C | Provenance output и watermark политики | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-GENESIS-C10` | C | Резервирование originals без потери metadata | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-GENESIS-C11` | C | Контракт media output с NEXUS | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-GENESIS-C12` | C | Контракт delivery/view с EXPERIENCE | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-GENESIS-C13` | C | Негативные тесты вредоносных media metadata | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-GENESIS-C14` | C | Staging E2E upload→process→publish→revoke | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-GENESIS-C15` | C | Независимый asset/license/security review | Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof |
| `M182-GENESIS-D01` | D | Выполнить source-pinned интеграционный E2E в staging | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-GENESIS-D02` | D | Получить независимое security+CODEOWNERS review без саморевью | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-GENESIS-D03` | D | Провести backup/restore и rollback rehearsal на реальном окружении | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-GENESIS-D04` | D | Измерить latency, error budget, alerts и on-call готовность | Подписанные независимые доказательства; без подмены local PASS на production GO |
| `M182-GENESIS-D05` | D | Зафиксировать отдельное owner GO/NO-GO с полным реестром доказательств | Подписанные независимые доказательства; без подмены local PASS на production GO |

## Запреты

- Нельзя утверждать original task DONE без настоящего исходного ID, commit SHA и внешнего reviewer.
- Нельзя импортировать кэши, локальные SQLite или шрифты STYLO без лицензий.
- Нельзя сливать межкомандные файлы по дате или только по хешу; требуется review обоих вариантов.
- Любая попытка production deploy блокируется до подписанного независимого owner GO.
