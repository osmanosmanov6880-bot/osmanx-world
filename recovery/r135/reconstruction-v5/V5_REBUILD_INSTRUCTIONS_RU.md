# Как восстановить реконструкцию V5 из сохранённых источников

Это способ собрать **реконструкцию**, а не исходный архив R135 на 503 МБ. Нужны Python 3, Git, два сохранённых ZIP обновлений и доступ к GitHub.

1. Скачайте из Библиотеки `OSGARD_R134_TO_R135_SOURCE_DELTA.zip` и `OSGARD_R135_TO_R136_SAFE_DELTA.zip`.
2. Получите копию `osmanosmanov6880-bot/osgard-world` на коммите `f3046ccd314e4ba0bcdf089d2308e7e1d3e742d9` и копию `osmanosmanov6880-bot/osmanx-world` на ветке `recovery/r135-20261104`. Сохраните обе копии и ZIP как исходники, не изменяя их.
3. Из папки `osmanx-world/recovery/r135/reconstruction-v5` запустите команду, заменив пути:

```bash
python3 rebuild_from_sources.py --manifest V5_REBUILD_MANIFEST.json \
  --source /path/to/OSGARD_R134_TO_R135_SOURCE_DELTA.zip \
  --source /path/to/OSGARD_R135_TO_R136_SAFE_DELTA.zip \
  --source /path/to/osgard-world/godot/osgard-r135-standalone \
  --source /path/to/osmanx-world/recovery/r135 \
  --out /path/to/new-v5-project
```

Папка назначения не должна существовать. Скрипт подбирает файлы только при совпадении SHA-256 и не создаёт проект, если каких-либо файлов не хватает. Затем откройте `project.godot` в Godot, импортируйте ресурсы и запустите сцену. Для командной проверки: `godot --headless --path /path/to/new-v5-project --editor --import`, затем `godot --headless --path /path/to/new-v5-project --script res://tests/reconstruction_smoke.gd`.

Визуальная проверка и физическая GPU не подтверждены. Полная база R134 и оригинальный 503-МБ ZIP остаются не найдены.
