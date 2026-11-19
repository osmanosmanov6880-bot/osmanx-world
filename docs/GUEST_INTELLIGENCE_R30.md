# OSMANX Guest Intelligence R30 — independent evidence review

Дата: 2026-11-19. Основа: R29 PR #64, HEAD `7b2e9a60765a08b0662b332378958147431783ab`.

## Пять полноценных блоков

1. **Цепочка 16 PR, точные SHA и CI.** `src/guest-r30-source-review.mjs` и `scripts/r30-review-github.mjs --github` проверяют pinned R29 #64, 5 именованных job, ancestry и точное Git tree относительно ранее проверенной цепочки 15 PR. Только GitHub GET; не выполняется merge. Source CI не приравнивается к post-merge main CI.
2. **Четыре независимых свидетельства Ed25519.** `src/guest-r30-evidence.mjs` требует отдельные публичные ключи, роли source reviewer, staging witness, recovery auditor, privacy officer, строгий UUID пилота и компании, commit SHA, R29 SHA-256, nonce и expiry не больше 10 минут. Проверяет подпись на строго упорядоченных байтах; запрещает повтор роли, nonce, ключа, просроченные или чужие сведения. Публичные ключи предоставляет доверенный внешний оператор. Криптографическая подпись не подтверждает истину содержимого.
3. **Независимая проверка минимизированных HTTP-наблюдений.** `src/guest-r30-probe.mjs` принимает только 10 фиксированных GET-наблюдений двух разрешённых логических origin: live/ready HTTP 200, private HTTP 401. Нет URL произвольного хоста, тел ответа, учётных данных, редиректов и контакта с VPS. Для синтетики всегда `realHostVerified:false`.
4. **Ограниченный по времени, проверяемый SHA-256 отчёт.** `src/guest-r30-report.mjs` связывает R29 с R30 на конкретный пилот, блокирует main CI, реальные staging и DR, согласия/договор, подписанные доказательства и окно изменений. Экспорт CSV защищён базовой моделью от формульных инъекций. Нет production GO.
5. **Русский кабинет, Fastify и CI.** Только `GET /api/industry/v1/guest/pilots/:id/r30/readiness` и `GET /api/industry/v1/guest/pilots/:id/r30/report.csv`; tenant MANAGE owner/manager, no-store, скрыто от чужой компании. Независимые доказательства намеренно не импортируются по сети через API. Дальнейшие проверки: unit, UI contract, полный PostgreSQL regression, AGE DR, reproducible archive, read-only GitHub graph.

## Важная граница безопасности

R30 оставлен Draft поверх R29. Результаты GitHub Actions, включая успешные синтетические проверки, **не доказывают реальную эксплуатационную готовность**. Требуются независимые human reviews исходной цепочки, ручное объединение всех предыдущих PR, fresh CI на итоговом main, настоящий staging/VPS, внешнее восстановление, отдельная проверка отката, согласие и договор первого клиента. По умолчанию `guestWritesDefault:false`. Никаких merge, deploy, migration, enabling collection, customer data access или STOP lift этим релизом не предусмотрено.
