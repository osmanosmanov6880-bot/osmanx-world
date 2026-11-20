# OSGARD SUPREME DIRECTOR — M190 · журнал восстановления

**Статус:** локальный инженерный модуль, не production и не подтверждение выполнения исходных 180 задач.

M190 дополняет M189. M189 сверяет происхождение исходников и тестовые свидетельства; M190 **не заменяет эту проверку**, а сохраняет проверяемую последовательность наблюдений и заметок оператора в локальной SQLite, чтобы после сбоя было понятно, что именно менялось.

## Что реализовано

1. Локальная база SQLite с `WAL` и `synchronous=FULL` для записей, упорядоченных по номеру.
2. Каждое событие содержит `previous_hash` и собственный SHA-256 хеш канонического JSON. В историю нельзя внести произвольное состояние `VERIFIED`.
3. Проверка допустимого M189-отчёта по 180 исходным заданиям, командам, приоритетам, зависимостям и статусам. Оригинальные задания всегда остаются **0/180 независимо принятых**.
4. Повторная загрузка идентичного отчёта идемпотентна, без дублирования.
5. Запись требует `--expected-head`, что предотвращает незаметную перезапись результата параллельным оператором.
6. Отдельные заметки оператора никогда не повышают статус задачи, не изменяют M189 и не дают разрешение на релиз.
7. Выгрузка полного журнала и создание контрольной точки (anchor) для отдельного хранения. Проверка по сохранённому anchor обнаруживает в том числе усечение последнего события.
8. Данные не выходят из локальной среды. Нет токенов, запросов к GitHub, платежей, запуска процессов из пользовательского журнала или production-деплоя.

## Команды

Из корня репозитория:

```bash
export PYTHONPATH=supreme-director
python3 -m m190 init --db /tmp/osgard-m190.db \
  --plan supreme-director/recovery/ORIGINAL_180_TASKS.json
```

При первом создании `head` будет 64 нуля (`GENESIS`). Далее получите **реальный локальный отчёт M189** (с примером пустых upstream в CI):

```bash
python3 supreme-director/m189/admission.py \
  --plan supreme-director/recovery/ORIGINAL_180_TASKS.json \
  --master supreme-director/originals/DIRECTOR_MASTER_180.md \
  --upstreams supreme-director/m189/data/M189_UPSTREAMS.json \
  --submissions supreme-director/m189/data/M189_SUBMISSIONS.json \
  --trust supreme-director/m189/data/M189_TRUST_KEYS.json \
  --workspace /tmp/osgard-unverified-team-checkouts \
  --evidence-root /tmp/osgard-unverified-test-logs \
  --output /tmp/osgard-m189-report.json

python3 -m m190 ingest --db /tmp/osgard-m190.db \
  --plan supreme-director/recovery/ORIGINAL_180_TASKS.json \
  --report /tmp/osgard-m189-report.json \
  --actor local-operator --expected-head $(python3 -c 'print("0"*64)')
```

Значение `head` из результата предыдущей команды передавайте следующей записи:

```bash
python3 -m m190 note --db /tmp/osgard-m190.db --task TITAN-X01 \
  --message 'Требуется owner-approved immutable Git SHA' \
  --actor qa-operator --expected-head ЗДЕСЬ_64_СИМВОЛА_HEAD

python3 -m m190 anchor --db /tmp/osgard-m190.db \
  --output /safe-separate-storage/OSGARD_M190_ANCHOR.json
python3 -m m190 verify --db /tmp/osgard-m190.db \
  --anchor /safe-separate-storage/OSGARD_M190_ANCHOR.json
python3 -m m190 export --db /tmp/osgard-m190.db --output /tmp/osgard-m190-export.json
```

**Важно:** `--expected-head` — CAS-ограничение для параллельных записей. При реальной работе сохраняйте контрольную точку **в независимом защищённом месте** и сравнивайте с нею. Сам SHA-256 журнал без внешнего якоря не защищает от администратора, переписавшего всю базу и цепочку; локальный anchor в той же папке тоже не является независимым доказательством. Подписанный/удалённый anchor можно добавить позднее после подтверждения владельцев и доверенных ключей.

## Тестирование

```bash
PYTHONPATH=supreme-director python3 -m unittest discover \
  -s supreme-director/m190/tests -p 'test_*.py' -v
PYTHONPATH=supreme-director python3 supreme-director/m190/smoke.py
```

Сквозной smoke запускает реальную команду M189 на пустом списке канонических upstream и проверяет: 180 `BLOCKED_UPSTREAM`, запись двух событий, отдельную контрольную точку и повторную идемпотентную загрузку отчёта.

## Ограничения

- M190 проверяет **структуру полученного отчёта M189**, но не перепроверяет самостоятельно удалённые репозитории и доверенные подписи. Сначала запускайте M189 в отдельной доверенной среде.
- Записи `READY_FOR_EXTERNAL_REVIEW` означают только готовность отдельных свидетельств к дальнейшему аудиту, **не** независимую приёмку и **не** право деплоя.
- Сообщения заметок могут содержать предоставленные оператором сведения. Не помещайте туда пароли, токены, персональные или конфиденциальные данные.
- Локальное восстановление не доказывает происхождение отсутствующих M180/M181. В исходном плане всё ещё **0/180**.
