# OSMANX Guest Intelligence R47 — независимый аудит первого PR #47

**Дата:** 20 ноября 2026. **Источник:** R46 Draft PR #96, HEAD `b78e889e9d08560e6eae713c0a03e0d9e0d5de46`.

**Цель:** завершить техническую подготовку к *реальному независимому ревью первого PR*, а не бесконечно считать количество Draft PR. Не подменять независимого человека проверкой GitHub Actions. **Все операции чтения, production/customer NO-GO.**

## Пять законченных блоков

1. **Точный десятифайловый R14 baseline.** `src/guest-r47-source-pins.mjs` хранит реальные SHA Git-блобов каждого из десяти исторических файлов PR #47 на `840bb083e606058a9a32450f3b3a3e881a34891e`. Локальный `git rev-parse SHA:path` и полный `git diff --name-only -z merge-base SHA` отказывают при любых новых, отсутствующих или изменённых файлах. Это подтверждает идентичность источника, **не качество кода**.
2. **Эффективная Docker Compose-политика изоляции.** `src/guest-r47-canary-policy.mjs` проверяет реальный `docker compose --profile setup -f ops/compose.r14.yml config --format json`, а не только grep по YAML. Разрешены только пять служб, приватная сеть и PostgreSQL volume, API только на `127.0.0.1:3150`, `GUEST_WRITES_ENABLED=false`, read-only и `no-new-privileges`. Нет worker, чужих портов или привилегированных контейнеров. CLI сначала сверяет сам YAML с историческим SHA #47, чтобы не проверять другой файл.
3. **Точная обязательная CI-проверка.** `src/guest-r47-first-checks.mjs` требует успешную `ops-contract` из GitHub Actions непосредственно на SHA первого PR. Неполная страница, старый SHA, skipped, pending или unrelated green check дают NO-GO. Остальные GitHub Actions checks также должны быть завершены успешно.
4. **Содержательный пакет независимого ревью и запреты.** `src/guest-r47-review-packet.mjs` выдаёт десять разных экспертных вопросов — для Compose, Docker оператора, мониторинга, Ed25519 допуска, инцидентов, проверки релиза и negative tests. Контроль двух разных доверенных **реальных** ревьюеров на текущем SHA, Draft-статуса, действительных main/merge-tree доказательств, ограничений branch protection и обязательного нового CI после реального слияния. Даже все зелёные технические признаки не дают права на автоматическое слияние или customer writes.
5. **Исполняемый read-only аудит, regression и CI.** `scripts/r47-first-review.mjs` читает Git-объекты и конфигурацию локально на одноразовом runner, потом делает только GitHub GET. Сохраняет чистый JSON и Markdown для ручного ревью; негативные тесты проверяют попытки скрыть открытые порты, подменить source SHA, пропустить ops-contract или использовать устаревшее одобрение.

## Проверка

```bash
cd services/industry-api
npm ci --ignore-scripts --no-audit --no-fund
node --test test/guest-r43-acceptance.test.mjs test/guest-r44-acceptance.test.mjs test/guest-r45-acceptance.test.mjs test/guest-r46-acceptance.test.mjs test/guest-r47-acceptance.test.mjs
```

Для `r47-first-review.mjs --json|--markdown` требуется одноразовый **полный** checkout GitHub с `origin/main`, установленным Docker CLI+Compose (контейнеры **НЕ запускаются**) и GitHub-token с правами **только читать** contents, pull requests и checks. Значения для Compose должны быть только фиктивными и тестовыми, не клиентскими секретами; GitHub Action их задаёт. Нельзя сохранять исходный файл с секретами в CI artifact.

Переменная `R47_TRUSTED_HUMANS` — два явно подтверждённых владельцем GitHub-логина **независимых людей**, через GitHub Repository Variables `GUEST_R47_TRUSTED_HUMANS`. Никаких фиктивных одобрений и никаких настоящих приватных ключей в CI.

## Ручное согласование первого PR

1. Два независимых специалиста открывают **[PR #47](https://github.com/osmanosmanov6880-bot/osmanx-world/pull/47)** и проверяют все десять файлов по Markdown-чеклисту. Особенно вручную проверяют `docker context default`: он сам по себе **не доказывает**, что пользовательский Docker socket указывает на локальную машину. Эту границу нельзя считать закрытой проверкой YAML.
2. Владелец репозитория подтверждает branch protection/rulesets. Если GitHub отвечает 403, статус **неизвестен**, а не «отключено».
3. Первый PR обновляют относительно **нового** `main` только после отдельного согласования. Это может изменить source SHA, что автоматически требует перепроверки графа последующих 32 PR и повторных одобрений.
4. Два независимых человека проверяют **новый** SHA и оставляют реальные одобрения. Не использовать старые approvals, GitHub Actions зелёные бейджи, ботов или собственное одобрение.
5. Только уполномоченный человек решает, можно ли объединить первый PR. После этого требуются свежий CI на `main`, независимый staging, внешний восстановленный бэкап, юридические/privacy-допуски и отдельное разрешение на включение записей.

**R47 не изменяет main, не делает merge/rebase, не размещает production, не запускает БД/контейнеры и не снимает STOP.**
