# OSGARD SUPREME DIRECTOR · подтверждённая поставка M191

**Дата:** 4 ноября 2026 · **Ветка:** `recovery/supreme-director-m187-20261104` · **PR:** [#7](https://github.com/osmanosmanov6880-bot/osmanx-world/pull/7)

## Подтверждённое состояние

- Модуль `supreme-director/m191/` опубликован в GitHub: безопасное SQLite online backup, проверка, восстановление в новый файл.
- Source inventory `M191_SOURCE_MANIFEST.json`: **8 из 8 исходных файлов** совпали с SHA-256.
- [GitHub Actions #41906309364](https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/41906309364): **completed / success**; unit/regression **26 tests / OK**.
- В этом же CI: синтетический end-to-end M189 → M190 → M191 → резервное копирование → восстановление: **PASS**.
- Исходная версия M191 сначала выявила ошибку: snapshot WAL оставлял `-wal/-shm` рядом с файлом. Отрицательные тесты её зафиксировали в [первом неуспешном CI](https://github.com/osmanosmanov6880-bot/osmanx-world/actions/runs/41906141480). После исправления нормализации копии (`journal_mode=DELETE` после checkpoint) проверки завершились успешно.
- Код M191 опубликован с проверенными входами, но **не** подтверждена совместимость с реальными производственными системами, настоящие архивы M180/M181 пока не найдены.

## Как проверить самостоятельно

Из корня репозитория:

```bash
python3 supreme-director/m191/verify_source.py
PYTHONPATH=supreme-director python3 -m unittest discover -s supreme-director/m191/tests -p 'test_*.py' -v
PYTHONPATH=supreme-director python3 supreme-director/m191/smoke.py
```

M189 использует `cryptography==46.0.4` из `supreme-director/local-kit/requirements-m185.txt`. Модуль M191 сам использует только стандартную библиотеку Python.

## Контроль статусов

| Контроль | Результат |
|---|---|
| Опубликован M191 | Да, в recovery-ветке |
| Пакет исходных файлов M191 | 8/8 SHA-256 PASS |
| Новые тесты M191 | 26/26 PASS |
| M189 → M190 → M191 синтетический сценарий | PASS |
| Историческая приёмка | 0/180 |
| Подтверждённые upstream шести команд | 0/6 |
| Допуск production | NO-GO |

**Нельзя** отождествлять сохранённую хеш-цепочку и независимую продуктовую приёмку. Для защиты от полного злонамеренного переписывания базы требуется доверенно сохранённый *вне каталога резервной копии* внешний якорь. Текущий комплект не предоставляет такой внешний сервис.
