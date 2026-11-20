# Release Gates: какие доказательства запрещено имитировать

- **G0 — Source:** оригинальный M181 SHA + точная Git цепочка M180→M181; six owner confirmed upstreams.
- **G1 — Conflicts:** 17 P0 + 11 P1 закрыты по реальным парам исходников и независимым PR reviews. Никакого автоматического разрешения из placeholder.
- **G2 — Contracts:** именно исходные девять интерфейсов M181 имеют tested producer+consumer в реальной stage. `M186 REFERENCE_FLOW_COMPLETE` недостаточно.
- **G3 — Users:** один важный результат end-to-end, измерены task success и ошибки, безопасная работа с данными.
- **G4 — Security:** IAM, изоляция, реальные secret/key boundaries, независимый тест sandbox, аудит vulnerability; минимум P0/P1 остаётся 0 перед решением GO.
- **G5 — Quality:** real-device UX, доступность, performance бюджеты, restore + rollback rehearsals, мониторинг.
- **G6 — 180 original tasks:** независимые reviewer receipts + exact SHA source, evidence и owner authorization на каждую задачу.
- **G7 — Owner release:** явное подписанное решение GO на неизменяемый candidate и возможность восстановить предыдущую рабочую версию.

До G7 **публичная эксплуатация запрещена**. Никакая часть M186 не может отправлять письма, брать деньги, публиковать в сеть или управлять GitHub release на основании тестовой зелёной карточки.
