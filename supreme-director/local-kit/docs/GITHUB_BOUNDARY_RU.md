# Границы репозиториев — 27.10.2026

Проверены подключённые GitHub аккаунты HADJAL001 и osmanosmanov6880-bot. Найдены несколько репозиториев с именем OSGARD, но **ни одному нельзя назначить одну из шести инженерных команд без подтверждения владельца и исходной цепочки**.

| Репозиторий | Наблюдавшийся HEAD (точный SHA) | Наблюдаемое направление |
|---|---|---|
| `HADJAL001/osgardos` | `269914113dca1d35e41501c5cc24d8848cdef26b` | веб-приложение / deployment |
| `osmanosmanov6880-bot/osgard-world` | `48cb8573efc4d1340c2b180cd0ff36961a9b3964` | game/cinema |
| `HADJAL001/osgard-world` | `0c0621f40f628e6818a0c38799a06e9f92723d60` | game stream |
| `HADJAL001/osgard-new-world` | `d40dd097af1a2f2f5eb283820e7f98e158854243` | world / deployment |
| `HADJAL001/osgard-infra-backups` | `89335796ce34f4c1bfd4f3725aaad4e75b2038a9` | backup archive |
| `osmanosmanov6880-bot/osgard-universe` | `5b7eeed9ab8e4f2084bea7925fb591a6f677bcbb` | initial repository |

Источник: read-only GitHub connector commits/search, 27.10.2026. Это наблюдения за default branch на момент запроса, а не pinned downstream M181 baseline.

Особенно важное разделение: `HADJAL001/osgardos/OSGARD-PROJECT-BOUNDARY.md` запрещает смешение OSGARD output `dist-osgard/` с GG Empire `dist-gg/`. Автоматическая попытка «найти любую ветку OSGARD и смержить шесть команд» была бы потенциальной порчей другого продукта.

Отдельная игра OSGARD W48–W58 может иметь собственные успешные CI/holding-gates, но эти проверки **не** являются приёмкой OSGARD DIRECTOR M181.
