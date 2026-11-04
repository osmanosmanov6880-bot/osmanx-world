# M186 Threat Model — локальный стенд, НЕ production

Защищаемые локальные свойства: целостность справочного реестра контрактов, предсказуемость типизированного потока, запрет ложной продакшен-авторизации, отбрасывание неподдерживаемых входных данных, целостность журнала при обычной порче и отказ от публичного сетевого доступа. Сценарии угроз: незнакомый JSON, подмена catalog после bootstrap, malformed envelope, route escalation, CSRF/CORS/Host injection, подмена таблицы SQLite, повторная отправка, утеря этапа, внесение фальшивого approval.

Реализованные меры: `127.0.0.1` и Host/Origin/Sec-Fetch-Site, bearer token, ограничение HTTP JSON, SQLite foreign keys и append-only triggers, SHA-256 повторный replay, exact 9 contract stages, `PRODUCTION_NO_GO`, immutable tasks/contract statuses. Негативные тесты проверяют нарушение схемы каждого этапа и запрет release route.

**Не защищено / не заявляется:** оператор с полным доступом к машине может изменить Python код + SQLite и пересчитать SHA; нет HSM, SSO, cross-tenant proof, TLS/Internet deployment, WAF, внешнего KMS, внешнего witness log, rate limits для публичной сети, независимой идентификации reviewer, SOC2/ISO/ASVS сертификации. Поэтому никакие настоящие credentials или sensitive data сюда не вводить, сервер не открывать в сеть. Реальный upstream adapter требует совершенно отдельной security qualification.
