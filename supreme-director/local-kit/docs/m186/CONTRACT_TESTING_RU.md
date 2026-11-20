# Девять исполняемых эталонных контрактов M186

**Важно:** это собственная спецификация для проверяемого локального демо, а не найденные upstream API-контракты M181. Исходные девять интерфейсов остаются `UNVERIFIED` до проверки у владельцев.

| ID | Эталонный производитель → потребитель | Данные | Почему это не real E2E |
|---|---|---|---|
| 01 | TITAN → NEXUS | Local simulator scope / identity unproven | Нет настоящего IAM |
| 02 | NEXUS → COMMERCE | Rule-based intent | Нет реального AI и источников |
| 03 | COMMERCE → EXPERIENCE | Non-payable points | Нет оплаты/checkout |
| 04 | EXPERIENCE → GENESIS | Three UI placeholders | Нет настоящего UX/UI продукта |
| 05 | GENESIS → ORBITAL | Two asset placeholders | Нет медиа-рендеринга |
| 06 | ORBITAL → TITAN | Synthetic risk | Нет независимого аудита |
| 07 | NEXUS → COMMERCE | Synthetic quote consistency | Нет реального заказа |
| 08 | EXPERIENCE → GENESIS | Synthetic asset/layout match | Нет внешних ассетов |
| 09 | ORBITAL → TITAN | `LOCAL_REFERENCE_COMPLETE`, `production_authorized=false` | Нет deployment authority |

**Схема:** точное совпадение выходных ключей, Python-типа (`bool` не принимается вместо `int`), версии, source/consumer, `SYNTHETIC_REFERENCE_ONLY`. Каждое сообщение получает SHA-256 от входа и SHA-256 от envelope, каждый сохранённый шаг связан с предыдущим SHA. Повторное исполнение в `doctor` обнаруживает изменение request/response и отсутствующий этап. Это не доверенная подпись на внешнем HSM.

**Проверка ошибки:** `inject_fault_at='CONTRACT-05'` подставляет schema-invalid payload только в тестовом стенде. Результат обрывается на шаге 05, `REFERENCE_FLOW_COMPLETE` не выдаётся.

**Для реальной интеграции:** требуется фактический OpenAPI/JSON Schema, две подписи owner команд, совместимые версии, тесты с настоящим provider и consumer в разрешённом stage, trace/correlation ID, политики retries/idempotency, негативная матрица, A11y, обоснованная privacy model, аудит независимо от автора. После этого отдельная acceptance procedure может начать принимать конкретные исходные 180 задач — не по факту завершения reference flow.
