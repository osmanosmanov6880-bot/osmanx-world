"""Proposed global-quality verification catalog, not achieved compliance claims.

These are engineering acceptance questions. Product owner must approve numeric
budgets and the independent reviewer must decide the appropriate standard scope.
"""
from __future__ import annotations

DOMAINS = {
    'PROVENANCE': (
        ('SOURCE-01', 'M180/M181 source SHA provenance independently reconciled', 'pinned archives and original Git ancestry'),
        ('SOURCE-02', 'Six canonical upstream repositories confirmed by their owners', 'branch, owner, 40-char SHA and GitHub review'),
        ('SOURCE-03', '180 original tasks and 294 dependencies verifiably mapped', 'original board, crosswalk, independent signature'),
        ('SOURCE-04', '28 actual conflicts independently reviewed', '17 P0 and 11 P1 decisions with exact-code evidence'),
    ),
    'SECURITY': (
        ('SEC-01', 'Independent threat model for all trust boundaries', 'review report and remediation receipts'),
        ('SEC-02', 'Appropriate OWASP ASVS 5.0.0 verification completed', 'full scope report; no official OWASP certification implied'),
        ('SEC-03', 'Tenant/RBAC/SSO secrets isolation proven by negative tests', 'separate security reviewer and negative case logs'),
        ('SEC-04', 'External penetration test and incident exercises closed', 'independent audit, defects and retests'),
    ),
    'INTEGRATION': (
        ('INT-01', 'Nine API contracts validated with consumer/provider E2E', 'pinned schema hashes and CI logs'),
        ('INT-02', 'Six product teams integrated at staging exact commit', 'cross-product build artifact hashes'),
        ('INT-03', 'Rollback and forward migration proven on realistic data', 'staging restore and data checks'),
        ('INT-04', '180 original tasks independently accepted', 'all task receipts after parent dependency acceptance'),
    ),
    'RELIABILITY': (
        ('SRE-01', 'Service-level indicators and SLO budgets approved', 'real product metrics and user-impact mapping'),
        ('SRE-02', 'Realistic load and latency benchmarks met', 'p50/p95/p99 on same source and environment'),
        ('SRE-03', 'Recovery RTO/RPO measured, not merely planned', 'dated restore run, checksums and alarms'),
        ('SRE-04', 'Production-grade observability and on-call validated', 'OpenTelemetry traces, metrics, logs, incidents'),
    ),
    'AI_QUALITY': (
        ('AI-01', 'Domain-specific AI evaluation sets and baseline measured', 'curated human-reviewed test set'),
        ('AI-02', 'Unsafe tool usage and prompt injection resistance tested', 'red-team tests and isolation boundaries'),
        ('AI-03', 'Privacy, retention, deletion and audit controls checked', 'privacy policy scope and executable evidence'),
        ('AI-04', 'AI latency, accuracy, cost and failure rates measured', 'verified workload report and budget'),
    ),
    'EXPERIENCE': (
        ('UX-01', 'Critical journeys pass accessibility review WCAG 2.2 AA', 'manual and automated audit, keyboard and touch'),
        ('UX-02', 'Desktop and actual mobile devices tested with users', 'physical-device logs and recordings'),
        ('UX-03', 'International localization and comprehensibility tested', 'RU, EN, locale-aware usability study'),
        ('UX-04', 'User task-completion and time-to-value beat baseline', 'controlled and ethically recruited user tests'),
    ),
    'MARKET': (
        ('MARKET-01', 'One target segment and high-value job-to-be-done validated', 'documented interviews and alternatives'),
        ('MARKET-02', 'Repeated usage and retained cohorts demonstrated', '30/60/90-day product analytics, not demos'),
        ('MARKET-03', 'Independent competitor benchmark on same tasks', 'methodology and verifiable comparison dataset'),
        ('MARKET-04', 'International support, legal and privacy delivery ready', 'real regions, service, contracts and support'),
    ),
    'ECONOMICS': (
        ('BIZ-01', 'Verified paying customers and willingness-to-pay', 'invoices and non-sensitive signed summary'),
        ('BIZ-02', 'Unit economics and cost-per-task measured', 'actual billings and variable cost ledger'),
        ('BIZ-03', 'Value realization and renewal/retention measured', 'cohort evidence and user value outcomes'),
        ('BIZ-04', 'Launch and sustainable operations financially approved', 'budget, runway and accountable operator'),
    ),
}

GATES = tuple({'id': key, 'domain': domain, 'requirement': desc,
               'required_evidence': proof, 'status': 'NOT_INDEPENDENTLY_VERIFIED'}
              for domain, rows in DOMAINS.items() for key, desc, proof in rows)
assert len(GATES) == 32 and len({g['id'] for g in GATES}) == 32
