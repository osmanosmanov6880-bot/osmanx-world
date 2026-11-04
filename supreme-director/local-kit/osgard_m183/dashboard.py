"""Static offline executive dashboard. No services, trackers, remote assets or deployment."""
from __future__ import annotations

from pathlib import Path
import json

from .core import write_new

TEMPLATE_PATH = Path(__file__).resolve().parent.parent / 'dashboard' / 'template.html'


def render_html(report, template_path=TEMPLATE_PATH):
    template = Path(template_path).read_text(encoding='utf-8')
    marker = '__REPORT_JSON__'
    if template.count(marker) != 1:
        raise ValueError('Exactly one escaped JSON payload marker required')
    payload = json.dumps(report, ensure_ascii=False, separators=(',', ':'))
    payload = payload.replace('&', '\\u0026').replace('<', '\\u003c').replace('>', '\\u003e')
    return template.replace(marker, payload)


def write_dashboard(path, report):
    return write_new(path, render_html(report))
