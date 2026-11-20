# OSGARD M205 — инженерный журнал четырёх блоков

Дата: 2026-11-06. Ветка recovery/supreme-director-m187-20261104, Draft PR #7.

## A: Reconciliation
Сверка M204 cost с M198 expense по tenant, виду, сумме и версиям. Мультисвязность запрещена partial unique indexes; ошибки обнаруживаются как SOURCE_VOIDED, SOURCE_VERSION_CHANGED и AMOUNT_OR_KIND_CHANGED. Кандидаты предлагаются, но не принимаются автоматически. M198 не прибавляется второй раз.

## B: Recurring model
Помесячные planned/reported затраты с interval 1..36, source reference, отменой по версии, immutable event chain и replay integrity. При отсутствии данных необходима явная zero-cost гипотеза на каждом расчёте.

## C: Net ROI
Три коэффициента realization_rate, net monthly cashflow, discounted? Нет: НЕ дисконтировано. Первый и устойчивый payback, отказ от ROI при неполных источниках и stale links. Сценарий не отражает налоги/финансирование и не подтверждает прибыль.

## D: Russian panel, CSV, tests
Реальный localhost /cost-control/, безопасный токен в памяти, CSP, owner-only, tenant scope, экспорт CSV. Тесты: запись затрат, дубликаты, смена версии источника, cost matching, регулярные месяцы, negative net ROI, zero-cost explicit, tamper, concurrency, HTTP и synthetic chain M198-M204-M205-M195-M203. CI Python 3.11/3.13 и M192–M204 regression.

Production NO-GO. Независимая приёмка 180 исходных upstream задач 0/180. Браузерная физическая визуальная приёмка не выполнена.

Откат: остановить M205, восстановить проверенный backup SQLite c WAL и использовать предыдущий зафиксированный код M204. Не удалять созданные таблицы вручную.
