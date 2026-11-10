# OSGARD M186 — эксплуатация локального стенда

## Быстрый запуск

1. Распаковать ZIP в отдельную папку, поставить Python 3.13. На Windows — `py -3.13 -m pip install -r requirements-m185.txt`; Linux/macOS — виртуальное окружение и `python3 -m pip install -r requirements-m185.txt`.
2. Windows: `START_OSGARD_M186_WINDOWS.cmd`, Linux/macOS: `./START_OSGARD_M186_LINUX_MAC.sh`.
3. В браузере того же компьютера открыть `http://127.0.0.1:8765/` и вставить токен только из локального терминала.
4. Вкладка **Integration Lab**: выбрать сценарий, тестовые points, выполнить reference chain, посмотреть девять контрактов и receipt. Затем выбрать намеренный сбой `CONTRACT-05`: должны появиться `BLOCKED_REFERENCE_CONTRACT` и красный этап.
5. `python3 -m osgard_m186 doctor` проверяет SQLite, исходные локальные доказательства, конфигурацию reference catalog и SHA-цепочки. Проверка не заменяет внешнее attestation.

## Команды проверки

```
python3 -m osgard_m186 init
python3 -m osgard_m186 run --scenario LEARNING_PLATFORM --operator local-operator --budget-points 1200
python3 -m osgard_m186 run --inject-fault-at CONTRACT-05
python3 -m osgard_m186 runs
python3 -m osgard_m186 doctor
python3 -m unittest discover -s tests -q
```

Никаких реальных платежей, внешних вызовов, почты, deploy, импорта приватных ключей или сторонних данных не происходит. Не выставлять сервер за `127.0.0.1`, не переносить тестовый токен в Git, не использовать демонстрационную SQLite как production-базу. Для выхода из демо в реальные системы нужна отдельная архитектура безопасности, владельцы и разрешённый stage.

## Как читать результаты

- `REFERENCE_FLOW_COMPLETE`: только девять локальных эталонных adapter contracts согласовались. **Не** означает E2E шести настоящих систем.
- `BLOCKED_REFERENCE_CONTRACT`: локальная схема отвергла один этап. Это намеренная или фактическая ошибка стенда, не сигнал успешной работы.
- `LOCAL_INTEGRITY_PASS`: самопроверка текущего стенда не выявила несоответствий; не независимый аудит.
- `0 real integrations`, `0/180 independently accepted`, `PRODUCTION_NO_GO`: обязательные факты до внешнего подтверждения.

## Сохранение данных

Остановить сервер и сделать копию `runtime/m186.sqlite3` с помощью штатного SQLite backup API; не копировать только WAL-файл при открытой БД. При восстановлении на другой компьютер не переносить личные или production данные. Отдельно восстановить каталог `templates/REFERENCE_CONTRACTS_M186.json` в точности до исходного SHA. Если `doctor` нашёл изменение — не очищать историю вручную; задокументировать причину и восстановить неизменённый архив.
