# M188 · Проверенный перенос исходного кода в GitHub

**Дата:** 4 ноября 2026 · **Ветка:** `recovery/supreme-director-m187-20261104` · **PR:** [#7](https://github.com/osmanosmanov6880-bot/osmanx-world/pull/7)

## Проверенные факты

- Из сохранённого архива `OSGARD_EMPIRE_M187_RECOVERY_FULL_2026-11-04.zip` извлечены 127 выбранных текстовых файлов кода, интерфейсов, тестов, шаблонов, документации и скриптов.
- SHA-256 исходного архива: `e5a25cb74a3f456266f33d8d6330cb127764916e940797f3228f049057a7a436`.
- Созданы новый скрипт `scripts/verify_source_only.py`, уведомление `SOURCE_ONLY_NOTICE_RU.md` и `SOURCE_TRANSFER_MANIFEST.json`. Получен **самодостаточный текстовый каталог из 130 файлов** в `supreme-director/local-kit/`.
- 129 файлов представлены в манифесте `SOURCE_TRANSFER_MANIFEST.json`; сам манифест не включает собственный хеш во избежание рекурсии.
- В GitHub проверено точное соответствие **130 из 130 путей** манифесту — отсутствующих и незаявленных файлов нет.
- `supreme-director/scripts/verify_source_transfer.py` в CI сверяет каждый путь, длину и SHA-256 всех 129 файлов, запрещает небезопасные пути и подтверждает SHA исходного архива.
- Локально: `python3 scripts/verify_source_only.py` — **22/22 PASS**; из 23 тестов `test_m187.py` один намеренно исключён, так как отсутствует исторический бинарный Git-bundle.
- Локально: `python3 -m osgard_m187 restore-plan` и `python3 -m osgard_m187 plan-waves` — exit 0; структура 180 задач, 6 команд и 294 ссылки, четыре волны.
- Локально: `node --check` для студий M184–M186 — exit 0.
- GitHub Actions [#41844376779](https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/41844376779) — обе jobs `integrity` и `source-transfer` закончились **success** на коммите `45d5c543bdc4d08b4ee8f748de1ac84e9be02efc`.

## Что в GitHub

```
supreme-director/
  originals/                  # оригинальный пользовательский 180-пунктный план
  recovery/                   # восстановленный JSON и граф зависимостей
  web/                        # отдельная русская панель задач
  local-kit/
    osgard_m182/ ... osgard_m187/
    dashboard/m184/ ... m186/
    docs/
    templates/
    tests/
    scripts/
    recovery_m187/
    originals/
    SOURCE_TRANSFER_MANIFEST.json
  scripts/verify_source_transfer.py
```

## Что не входит в этот Git-слепок

- Исторические Git-bundle M184/M185/M186, вложенные исходные ZIP, PNG доказательств и бинарные артефакты из полного M187 ZIP на 207 829 838 байт.
- Оригинальные M180/M181 bytes и immutable commits; исходный канонический Git provenance неизвестен.
- Реальные upstream-исходники шести самостоятельных продуктовых систем и их независимые E2E доказательства.
- Реальные действия по платежам, отправкам, публичному деплою и управлению устройствами.

`source-only` не эквивалентен полному архиву M187; общий исторический набор тестов, требующий бинарные фикстуры, нельзя объявлять зелёным только на основании 22/22. **Исходные 180 задач: 0 независимо принятых. Production: NO-GO.**

## Команды воспроизведения

Из корня Git-репозитория:

```bash
python3 supreme-director/scripts/validate_plan.py
python3 supreme-director/scripts/verify_source_transfer.py
python3 supreme-director/local-kit/scripts/verify_source_only.py
cd supreme-director/local-kit
python3 -m osgard_m187 restore-plan
python3 -m osgard_m187 plan-waves
```

Убедитесь, что установлен Python 3.13 и `cryptography==46.0.4` из `requirements-m185.txt`. Запускайте локальный UI только на `127.0.0.1` с синтетическими данными. Не подключайте production.
