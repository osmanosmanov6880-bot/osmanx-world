# TITAN-X01 — реальная реализация проверки Git baseline

16.11.2026. Исходный план: `supreme-director/originals/DIRECTOR_MASTER_180.md`.
Ветка: `recovery/supreme-director-m187-20261104`; не изменять main/production.
База до реализации: `576d9c4b33f1688fe924f251f8b494a99aae117c`.

## Что реализовано

`campaign180/titan_source_provenance.py` получает отдельные checkouts KRAKEN,
DevSwarm, Command, подписанную owner-policy с точными repo URL/commit/tree/branch,
отдельно закреплённый SHA256 DER публичного Ed25519 ключа и подпись policy.
Проверяет подпись и каждый реальный Git HEAD, origin, branch, Git tree, все
отслеживаемые обычные файлы и их Git blob SHA1 + SHA256, чистоту tracked/staged/
untracked, размеры, symlinks/submodules, наличие программного кода.
Не создаёт новые компоненты, не обращается к сети, не меняет исходники.

Тесты: `tests/test_titan_x01_canonical.py` — десять реальных сценариев Git
временных репозиториев с Ed25519 и негативными проверками.
CI: `.github/workflows/titan-original-x01-canonical.yml` — Python 3.11/3.13
и старые X01-X05 регрессии; PASS только после завершённого запуска.

## Фактически установленный блокер

В `campaign180/data/UPSTREAM_REGISTRY.json` нет owner-approved URL и SHA
ни для одной из шести команд. Доступны:
- osmanosmanov6880-bot/osmanx-world, default main:
  `e7c2cf6d94ef6361620993b65cb55477134bace2`
- osmanosmanov6880-bot/osgard-world, default master:
  `0cd2b0fd58377c5a50fb7603c6ffcde0a0d14c48`

Ни один из них НЕ подтверждён как оригинальный KRAKEN/DevSwarm/Command.
Подписавший policy и независимый reviewer требуют отдельной identity и
security-проверки; указанные строки не заменяют независимую приёмку.

## Запуск для реальных исходников

```bash
PYTHONPATH=supreme-director/campaign180 python -m campaign180.titan_source_provenance \
  --policy /secure/canonical-policy.json --signature /secure/policy.sig \
  --public-key /secure/owner.pub --trusted-key-sha256 <externally-pinned-sha256> \
  --kraken /src/kraken --devswarm /src/devswarm --command /src/command
```

**Оригинальный статус: BLOCKED_UPSTREAM**, пока не получены реальная
каноническая подписанная policy, три источника и независимая приёмка.
Положительные тесты с синтетическими checkout — проверка механизма,
не подтверждение оригинального продукта.

Откат: revert этого коммита, действующие исходники и production не изменялись.
