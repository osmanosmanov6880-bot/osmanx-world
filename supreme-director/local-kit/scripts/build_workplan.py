#!/usr/bin/env python3
"""Generate proposed *M182* work plan, NOT the historical original 180-task board."""
from collections import Counter
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

DOMAINS = {
 "TITAN": {
  "display": "TITAN / KRAKEN",
  "focus": "защищённое исполнение задач, очереди и sandbox",
  "build": [
   "Ревизия immutable job queue и границ задач", "Восстановление worker lease/fencing по exact commit",
   "RBAC для постановки, отмены и просмотра задач", "Негативные tenant isolation тесты на уровне task API",
   "Docker sandbox без host mounts и неявных pull", "Карантин хоста при неподтверждённом cleanup",
   "Ограничения CPU/RAM/time и безопасное прерывание", "Идемпотентная обработка повторно доставленного задания",
   "Неподменяемый execution log и provenance artifacts", "Защита состояния очереди после crash и reboot",
   "Cross-service API с NEXUS/ÆTHERION", "Обработка untrusted code без escape и секретов",
   "Наблюдаемость worker health и аварийных переходов", "Staging E2E создание→исполнение→отмена→аудит",
   "Независимое ревью runtime и sandbox boundary"],
  "security": "изоляция исполняемого кода и межпроцессные полномочия"},
 "NEXUS": {
  "display": "NEXUS / ÆTHERION",
  "focus": "модели, агентные задания и доступ к инструментам",
  "build": [
   "Инвентаризация model/provider adapters и API версий", "Отдельные tenant-scoped agent sessions",
   "Проверка permission scopes всех инструментов", "Ограничение бюджета токенов и rate limits",
   "Prompt injection boundaries для retrieved content", "Deny-by-default при отказе provider/auth",
   "Версионирование prompt/template с происхождением", "Трассировка tool invocations без записи секретов",
   "Staging с synthetic model failures и timeouts", "Подпись, TTL и ревокация agent grants",
   "Контракт очереди TITAN job→agent task", "Контракт медиа-выхода GENESIS с лицензией",
   "Data retention, erasure и privacy gate", "E2E от запросов до проверяемого конечного результата",
   "Независимое ревью модели угрозы и источников"],
  "security": "границы tool calls, prompt injection и tenant data"},
 "COMMERCE": {
  "display": "COMMERCE",
  "focus": "заказы, биллинг и контроль денежных состояний",
  "build": [
   "Контракт заказа с неизменяемыми identifiers", "Idempotency key для create/charge/refund",
   "Верификация подписей и replay window webhook", "Transactional outbox и retry семантика",
   "Согласованность ledger и external provider states", "Безопасная миграция схемы заказов",
   "Разделение финансовых/административных ролей", "PCI/privacy scope и запрет логирования PAN/секретов",
   "Staging provider sandbox без реальных списаний", "Reconciliation разногласий event и ledger",
   "Контракт purchase entitlement с EXPERIENCE", "Контракт платежного события для ORBITAL analytics",
   "Нагрузочные и отказные сценарии duplicate webhook", "E2E create→pay→refund→receipt в тестовом окружении",
   "Независимое security/finance review"],
  "security": "платежные записи, идемпотентность и авторизация денежных действий"},
 "EXPERIENCE": {
  "display": "HUMAN EXPERIENCE",
  "focus": "пользовательский опыт, права доступа и локализация",
  "build": [
   "Матрица ролей UX и access denial", "Защищённый session lifecycle и logout",
   "Проверка consent/privacy UI", "RU/EN и устойчивость длинных строк",
   "Keyboard/screen-reader основные сценарии", "Fallback для offline и медленной сети",
   "Error boundary для недоступных интеграций", "Отказ по оплате без ложной выдачи entitlement",
   "End-to-end прохождение регистрации и входа", "Изоляция профилей разных пользователей",
   "Контракт разрешений с COMMERCE", "Контракт контента с GENESIS MEDIA",
   "Telemetry без PII и с opt-out", "Визуальная приёмка на реальных desktop/mobile устройствах",
   "Независимое UX/accessibility/privacy review"],
  "security": "пользовательские данные, доступность и согласия"},
 "GENESIS": {
  "display": "GENESIS MEDIA",
  "focus": "производство медиа, происхождение и права использования",
  "build": [
   "Реестр медиа-активов с лицензиями", "SHA-проверка входных asset bytes",
   "Безопасная загрузка/сканирование форматов", "Изоляция media worker и лимиты ресурса",
   "Очередь transcode/generate с retry и cancel", "Проверка авторских прав и brand approvals",
   "Ротация signed media URLs и access tokens", "Контроль CDN cache invalidation",
   "Provenance output и watermark политики", "Резервирование originals без потери metadata",
   "Контракт media output с NEXUS", "Контракт delivery/view с EXPERIENCE",
   "Негативные тесты вредоносных media metadata", "Staging E2E upload→process→publish→revoke",
   "Независимый asset/license/security review"],
  "security": "лицензии, вредоносные входные файлы и доступ к медиа"},
 "ORBITAL": {
  "display": "ORBITAL",
  "focus": "исследования, метрики и доказательства решений",
  "build": [
   "Реестр исследовательских гипотез и источников", "Разделение симуляции и production фактов",
   "Детерминированное воспроизведение расчётов", "Контроль целостности ledger исследовательских фактов",
   "Сведение экономических допущений и uncertainty", "Негативные тесты stale и manipulated evidence",
   "Identity/authorization голосований и подписей", "Защита от replay/double-count в vote evidence",
   "Сравнение результатов экспериментов по версиям", "Observability для источников/датасетов",
   "Контракт событий COMMERCE→ORBITAL", "Контракт model metrics NEXUS→ORBITAL",
   "Audit trail с signed checkpoints", "E2E research→review→decision без auto-GO",
   "Независимое scientific/economic/security review"],
  "security": "подлинность источников, воспроизводимость и независимые решения"},
}

SECURITY = [
 "Назначить CODEOWNERS и read-only ACL карту",
 "Проверить SSO/IAM/RBAC для доменного контура",
 "Зафиксировать secrets, keys и принцип минимальных прав",
 "Составить SBOM/лицензии, запретить неподтверждённые зависимости",
 "Зафиксировать boundary sandbox/network/tenants",
 "Утвердить immutable schema и версионирование API",
 "Подготовить безопасные миграции и rollback",
 "Определить negative security tests и evidence retention",
]
RELEASE = [
 "Выполнить source-pinned интеграционный E2E в staging",
 "Получить независимое security+CODEOWNERS review без саморевью",
 "Провести backup/restore и rollback rehearsal на реальном окружении",
 "Измерить latency, error budget, alerts и on-call готовность",
 "Зафиксировать отдельное owner GO/NO-GO с полным реестром доказательств",
]


def make_tasks():
    rows = []
    for team, cfg in DOMAINS.items():
        entries = [
            ("A", "Привязать канонический upstream Git commit, владельца и ветку", "Ссылка на репозиторий; read-only Git SHA; владелец подтверждает соответствие продукта"),
            ("A", "Подтвердить происхождение M181, задачу и исходные зависимости", "Original source ZIP+SHA, task crosswalk, конкретный оригинальный ID"),
        ]
        entries += [("B", x, "Проверенная модель угроз, CI negative case и два раздельных reviewer evidence") for x in SECURITY]
        entries += [("C", x, "Патч только в своей ветке, точный Git SHA, positive+negative tests, staging proof") for x in cfg["build"]]
        entries += [("D", x, "Подписанные независимые доказательства; без подмены local PASS на production GO") for x in RELEASE]
        assert len(entries) == 30, (team, len(entries))
        prev_id = None
        counters = Counter()
        for phase, title, evidence in entries:
            counters[phase] += 1
            ident = f"M182-{team}-{phase}{counters[phase]:02d}"
            rows.append({"id": ident, "planning_only": True,
                         "source_task_id": None, "team": team, "display_team": cfg["display"],
                         "phase": phase, "description": title,
                         "acceptance_evidence": evidence,
                         "local_dependencies": [prev_id] if prev_id else [],
                         "canonical_upstream_sha": None, "owner": None,
                         "independent_reviewer": None,
                         "status": "NOT_ACCEPTED"})
            prev_id = ident
    return rows


def main():
    rows = make_tasks()
    phase = Counter(x["phase"] for x in rows)
    team = Counter(x["team"] for x in rows)
    assert dict(phase) == {"A":12,"B":48,"C":90,"D":30}
    assert all(team[t] == 30 for t in DOMAINS)
    result = {"schema": "osgard.m182.workplan/1", "project": "OSGARD M182",
              "status": "PROPOSED_EXECUTION_PLAN_ONLY", "not_original_M181_board": True,
              "reported_original_dependency_edges": 294,
              "new_plan_dependency_edges": sum(len(x["local_dependencies"]) for x in rows),
              "phase_counts": dict(phase), "team_counts": dict(team), "tasks": rows}
    f = ROOT/"docs/M182_WORKPLAN_180_PROPOSED.json"
    f.write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True)+"\n", encoding="utf-8")
    for team_id, cfg in DOMAINS.items():
        team_rows = [r for r in rows if r["team"] == team_id]
        out = [f"# M182 — задание {cfg['display']}", "",
               "**Предлагаемый инженерный маршрут из 30 задач; это НЕ оригинальные 30 задач M181.**",
               "Оригинальные ID и 294 зависимости могут быть связаны только после сверки SHA-pinned ZIP и upstream Git.", "",
               f"Фокус: {cfg['focus']}. Критический риск: {cfg['security']}.", "",
               "| ID | Блок | Задание | Приёмочное доказательство |", "|---|---|---|---|"]
        for row in team_rows:
            out.append(f"| `{row['id']}` | {row['phase']} | {row['description']} | {row['acceptance_evidence']} |")
        out += ["", "## Запреты", "",
                "- Нельзя утверждать original task DONE без настоящего исходного ID, commit SHA и внешнего reviewer.",
                "- Нельзя импортировать кэши, локальные SQLite или шрифты STYLO без лицензий.",
                "- Нельзя сливать межкомандные файлы по дате или только по хешу; требуется review обоих вариантов.",
                "- Любая попытка production deploy блокируется до подписанного независимого owner GO.", ""]
        (ROOT/f"docs/HANDOFF_{team_id}_30_RU.md").write_text("\n".join(out), encoding="utf-8")
    print(json.dumps({"new_workplan": str(f.relative_to(ROOT)),
                      "total": len(rows), "phases": dict(phase), "teams": dict(team)}, ensure_ascii=False))

if __name__ == "__main__":
    main()
