# OSGARD SUPREME DIRECTOR M206 — диагностика и проверка прогнозов

Локальное продолжение M205: четыре крупных блока реального кода поверх прежних SQLite-данных. Все финансовые источники по-прежнему введены владельцем; M206 не производит платежей и не заменяет банковский аудит.

## 1. Детерминированная диагностика

API:
- commerce.assurance.scan — проверить данные и сохранить снимок;
- commerce.assurance.latest — получить последний неизменённый снимок;
- commerce.assurance.history — история проверок.

Скан сверяет M203 plan, M204 entries и ledger, M205 cost links и recurring. Правила:
- SOURCE_LINK_DRIFT: расход M198 изменился, исчез или отменён после привязки;
- UNLINKED_MANUAL_COST: ручной расход M204 не сопоставлен с M198;
- AMBIGUOUS_LOCAL_MATCH: найдено несколько кандидатов;
- CROSS_BASIS_REFERENCE_REVIEW: один номер основания повторяется в planned и incurred (не обязательно ошибка);
- CROSS_PLAN_SOURCE_REFERENCE: совпадающий reference / kind / amount встречается в другом плане этой организации (может быть законным распределением);
- NO_ONE_TIME_COST_BASIS: нет разовой стоимости;
- NO_MONTHLY_BENEFIT_FORECAST: нет ожидаемой ежемесячной выгоды;
- RECURRING_SOURCE_UNKNOWN: не введены регулярные расходы ни одного типа; отсутствие записей не равно нулю.

Каждое предупреждение имеет детерминированный идентификатор, severity, source_ref и detail. При усечении источника скан не утверждает полноту. Замечание не становится доказательством двойной банковской оплаты.

## 2. Неизменяемый журнал и ручное рассмотрение

Каждый scan сохраняет полный канонический JSON, SHA-256 хеш содержимого, предыдущего снимка и исходных M203/M204/M205 цепочек. m206_events — отдельный per-tenant/per-plan/domain журнал; при чтении события сверяются с текущими строками. Триггеры SQLite запрещают обычные UPDATE и DELETE снимков, базовых прогнозов и событий.

API commerce.assurance.acknowledge требует причину, scan_id и finding_id последнего скана. Статус ACKNOWLEDGED_NOT_RESOLVED означает только рассмотрение владельцем. Изменения проверяются повторным scan; старое подтверждение не переносится автоматически.

SHA-256 цепочки находятся в одной локальной SQLite, без независимого внешнего якоря, доверенной электронной подписи или независимого владельца ключа. Привилегированного администратора они полностью не исключают из угроз.

## 3. Сохранённые исходные прогнозы и наблюдения

API:
- commerce.forecast.freeze — сохранить полный помесячный сценарий M205 и хеши исходных M204/M205 данных, после проверки всех обязательных условий расчёта;
- commerce.forecast.list — список неизменяемых прогнозов;
- commerce.forecast.observation.add — owner вручную заявляет валовую выгоду и операционные расходы за месяц 1..36 с reference и evidence_note;
- commerce.forecast.observation.void — отменить неверный отчёт с причиной и создать новый (история остаётся);
- commerce.forecast.backtest — сравнить неизменённые месячные ожидания с заявленными отчётами.

В форме freeze указываются plan_id, cost_basis, recurring_basis, horizon_months, три realization_rates_bp, scenario_index 0/1/2, require_reconciled_costs, assume_zero_recurring и rationale. Если M205 не может построить прогноз из полных данных, freeze отклоняется.

Метрики:
- predicted net — frozen projected gross benefit minus expected operating cost;
- owner-reported net — manually reported gross minus manually reported operating cost;
- error = reported net minus predicted net;
- MAE = floor(sum absolute error divided by observed-month count);
- signed bias = floor(sum signed error divided by observed-month count);
- coverage_bp = floor(observed_months * 10000 / horizon).

При отсутствии наблюдений MAE и bias = null; пропущенные месяцы не заполняются нулями. Если M204/M205 изменены позднее, система сообщает source drift, но не переписывает старый прогноз задним числом. Это анализ владельческих отчётов, а не независимая проверка фактически полученных денег. Нельзя доказать, что фиксация произошла до реального периода за пределами SQLite.

## 4. Русская OBSIDIAN панель, пакет доказательств, CI

Локальный адрес после запуска: http://127.0.0.1:8726/assurance/

Панель позволяет сканировать планы, рассматривать предупреждения, фиксировать прогноз, записывать месячные наблюдения и анализировать абсолютную и систематическую ошибку. В разделе портфеля можно сформировать:
- commerce.assurance.packet — локальный JSON-пакет с хешем и историей;
- commerce.assurance.portfolio / portfolio.csv — отчёт по организации, spreadsheet formula injection mitigation.

Не выполняются внешние HTTP вызовы, банковские переводы или сообщения. Интерфейс принимает только локальный owner Bearer-токен, не сохраняет его в localStorage, работает с loopback-only сервером, CSP и tenant/RBAC проверки унаследованы от M192–M205.

### Запуск на новой базе

Из корня репозитория с Python 3.11+:

    export PYTHONPATH="$(pwd)/supreme-director/m192:$(pwd)/supreme-director/m193:$(pwd)/supreme-director/m194:$(pwd)/supreme-director/m195:$(pwd)/supreme-director/m196:$(pwd)/supreme-director/m197:$(pwd)/supreme-director/m198:$(pwd)/supreme-director/m199:$(pwd)/supreme-director/m200:$(pwd)/supreme-director/m201:$(pwd)/supreme-director/m202:$(pwd)/supreme-director/m203:$(pwd)/supreme-director/m204:$(pwd)/supreme-director/m205:$(pwd)/supreme-director/m206"
    python3 -m osgard_m206 init --db ./director-local.sqlite --tenant "Моя компания"
    python3 -m osgard_m206 serve --db ./director-local.sqlite --port 8726

Windows: в PYTHONPATH используйте точку с запятой вместо двоеточия.

Для существующей базы M205 остановите старую службу, сохраните и проверьте резервную копию SQLite с WAL, затем запускайте только serve --db ./existing.sqlite, а не init. Миграция добавочная и не удаляет M192–M205. Команда one-shot M202 monitor остаётся доступна: python3 -m osgard_m206 run-due --db ./existing.sqlite --token-stdin.

### Контрольные испытания

    node --check supreme-director/m206/osgard_m206/web/app.js
    python3 -m unittest discover -s supreme-director/m206/tests -p 'test_*.py' -v
    python3 supreme-director/m206/smoke.py

CI выполняет также всю регрессию M192–M205 на Python 3.11/3.13. Синтетические испытания не являются аудиторским заключением.

### Ограничения и релизный гейт

Нет банковских выписок, подтверждённой фактической прибыли, электронных независимых подписей, проверки реальной причинности, доказанной финансовой выгоды и физической браузерной приёмки на смартфонах. Первоначальные 180 upstream-заданий независимо приняты 0/180. PR остаётся Draft, production NO-GO, main и публичный deploy не затрагиваются.
