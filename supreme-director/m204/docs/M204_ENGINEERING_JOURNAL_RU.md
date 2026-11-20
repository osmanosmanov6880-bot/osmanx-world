# M204 · Инженерный журнал четырёх блоков

Дата: 5 ноября 2026. Репозиторий osmanosmanov6880-bot/osmanx-world, рабочая ветка recovery/supreme-director-m187-20261104, Draft PR #7.

1. Ledger: economics_entries + immutable economics_events. Четыре непересекающиеся категории затрат/выгоды, целые копейки RUB, source notes, reference de-dup, отмена с обязательной причиной, транзакционное replay verification событий и состояний, tenant isolation, RBAC owner-only, idempotent writes.
2. ROI: economics_roi.py — явно указанные cost_basis/horizon/rates, проверки полноты, условные payback/ROI по ежемесячным гипотезам и отдельный self-reported разовый ROI. Не смешиваются cost_planned/cost_incurred и forecast/reported benefit; ноль не подставляется вместо неизвестного.
3. Priorities: economics_priorities — оценка владельца по urgency/impact/effort/confidence, субъективный score, версионность, reason, событие аудита; неоценённые планы остаются без ранга.
4. UI and QA: русская локальная адаптивная /economics/; отчёт портфеля с CSV formula guard; HTTP host/origin/CSP, локальные задачи M195 и планы M203 не меняются автоматически. Синтетический smoke связывает M201 risk → M203 plan → M195 task → M203 review → M204 projected ROI / claimed ROI / priority. Автоматизированный CI Python 3.11/3.13 + регрессии M192–M203.

Визуальная приёмка на физических устройствах не заявляется. Все суммы и допущения проверены только как локальные записи; отсутствие банковских доказательств явно отражено в API. Первоначальные 180 upstream-заданий 0/180 независимо приняты, production NO-GO.

Перед обновлением сделать проверенную резервную копию SQLite включая WAL. Для отката восстановить сохранённую копию и прежний проверенный коммит M203; не удалять новые таблицы вручную.
