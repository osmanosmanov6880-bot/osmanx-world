'use strict';
(() => {
  const state = { token: '', connected: false, summary: null, tasks: [], conflicts: [], contracts: [], sources: [], audit: [], page: 'overview' };
  const $ = (id) => document.getElementById(id);
  const node = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = String(txt); return e; };
  const empty = (parent) => { while (parent.firstChild) parent.removeChild(parent.firstChild); };
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.handle); toast.handle = setTimeout(() => t.classList.remove('show'), 3500); }
  async function api(path, method = 'GET', data) {
    if (!state.token) throw new Error('Connect your local bearer token first');
    const headers = { 'Authorization': 'Bearer ' + state.token };
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch('/api/v1/' + path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data), cache: 'no-store' });
    let body = await response.json();
    if (!response.ok) throw new Error((body && body.error) || 'HTTP ' + response.status);
    return body.data;
  }
  async function fetchAll() {
    const [summary, tasks, conflicts, contracts, sources, audit] = await Promise.all([
      api('summary'), api('tasks'), api('conflicts'), api('contracts'), api('sources'), api('audit')]);
    state.summary = summary; state.tasks = tasks; state.conflicts = conflicts; state.contracts = contracts;
    state.sources = sources; state.audit = audit;
    state.connected = true;
    $('connection-label').textContent = 'LOCAL DATABASE CONNECTED';
    $('connection-detail').textContent = 'No external services, payments, product merges or production writes';
    $('connection-label').parentElement.querySelector('.dot').classList.replace('warning', 'online');
    $('updated-label').textContent = 'SYNCED / ' + new Date().toLocaleTimeString();
    $('connect-button').textContent = 'Connected to local database';
    $('export-button').disabled = false;
    renderAll();
  }
  function showPage(page) {
    state.page = page;
    document.querySelectorAll('.nav-item').forEach(e => e.classList.toggle('selected', e.dataset.page === page));
    document.querySelectorAll('.page').forEach(e => e.classList.toggle('active', e.id === 'page-' + page));
    $('crumb-page').textContent = page.toUpperCase().replace('-', ' ');
    if (page !== 'overview' && !state.connected) toast('Connect local database to load this section');
  }
  function renderOverview() {
    if (!state.summary) return;
    $('metric-tasks').textContent = state.summary.counts.tasks;
    $('metric-conflicts').textContent = state.summary.counts.conflicts;
    $('metric-contracts').textContent = String(state.summary.counts.contracts).padStart(2, '0');
    const teams = Object.entries(state.summary.task_team_counts).sort((a, b) => a[0].localeCompare(b[0]));
    empty($('team-list'));
    teams.forEach(([name, count], i) => {
      const row = node('div', 'team-row');
      row.append(node('span', 'team-number', String(i + 1).padStart(2, '0')));
      const info = node('div'); info.append(node('div', 'team-name', name));
      const p = node('div', 'team-progress'); p.append(node('i')); info.append(p); row.append(info);
      row.append(node('span', 'team-meta', count + ' PLANNED / 0 ACCEPTED'));
      $('team-list').append(row);
    });
  }
  function openNote(kind, target, currentStatus) {
    $('note-kind').value = kind; $('note-target').value = target;
    $('note-title').textContent = 'Local note: ' + target;
    $('note-text').value = '';
    $('triage-wrap').hidden = kind !== 'conflict';
    const statuses = $('triage-status');
    empty(statuses);
    statuses.append(new Option('Add note only', ''));
    const allowed = { UNRESOLVED: ['TRIAGED', 'QUARANTINED'], TRIAGED: ['REVIEW_PENDING', 'QUARANTINED'], REVIEW_PENDING: ['QUARANTINED'], QUARANTINED: [] };
    (allowed[currentStatus] || []).forEach(status => statuses.append(new Option(status, status)));
    $('note-dialog').showModal();
  }
  function renderTasks() {
    const tbody = $('tasks-table'); empty(tbody);
    if (!state.connected) return;
    const team = $('task-team').value, q = $('task-query').value.toLowerCase().trim();
    const matches = state.tasks.filter(t => (!team || t.team === team) && (!q || t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)));
    if (!matches.length) { const tr = node('tr'); const td = node('td', '', 'No matching planned tasks.'); td.colSpan = 6; tr.append(td); tbody.append(tr); return; }
    matches.forEach(t => {
      const tr = node('tr'); tr.append(node('td', 'mono', t.id), node('td', '', t.team), node('td', '', t.phase), node('td', 'description', t.title));
      const status = node('td'); status.append(node('span', 'status-chip', 'NOT ACCEPTED')); tr.append(status);
      const action = node('td'); const button = node('button', 'table-btn', 'Log note');
      button.addEventListener('click', () => openNote('task', t.id)); action.append(button); tr.append(action); tbody.append(tr);
    });
  }
  function renderConflicts() {
    const list = $('conflict-list'); empty(list);
    state.conflicts.forEach(c => {
      const card = node('div', 'conflict-card'); const main = node('div');
      main.append(node('b', '', c.id));
      main.append(node('small', '', c.status + ' / origin still unverified'));
      card.append(main);
      const right = node('div'); right.append(node('span', 'severity' + (c.severity === 'P1' ? ' p1' : ''), c.severity + ' '));
      const btn = node('button', 'table-btn', 'Review'); btn.addEventListener('click', () => openNote('conflict', c.id, c.status));
      right.append(btn); card.append(right); list.append(card);
    });
  }
  function renderContracts() {
    const list = $('contract-list'); empty(list);
    state.contracts.forEach(c => {
      const card = node('div', 'contract-card'); card.append(node('div', 'eyebrow muted', 'UNVERIFIED CONTRACT'), node('b', '', c.id));
      card.append(node('small', '', 'No provider / consumer E2E evidence'));
      const btn = node('button', 'table-btn', 'Record note'); btn.addEventListener('click', () => openNote('contract', c.id));
      card.append(btn); list.append(card);
    });
  }
  function renderSources() {
    const list = $('source-list'); empty(list);
    if (!state.sources.length) { list.append(node('div', 'placeholder', 'No source observations have been recorded yet.')); return; }
    state.sources.slice(0, 40).forEach(o => {
      const row = node('div', 'source-row'); row.append(node('b', '', o.repo + ' / ' + o.branch));
      row.append(node('code', '', o.sha)); row.append(node('small', '', 'UNVERIFIED SOURCE OBSERVATION / NO TEAM MAPPING'));
      list.append(row);
    });
  }
  function renderAudit() {
    const list = $('audit-list'); empty(list);
    state.audit.forEach(e => {
      const row = node('div', 'audit-row'); row.append(node('b', '', '#' + e.sequence + '  ' + e.action + '  / ' + e.entity));
      row.append(node('small', '', e.at + ' / actor: ' + e.actor));
      row.append(node('code', '', 'SHA-256 ' + e.event_sha)); list.append(row);
    });
  }
  function renderAll() { renderOverview(); renderTasks(); renderConflicts(); renderContracts(); renderSources(); renderAudit(); }
  document.querySelectorAll('.nav-item').forEach(e => e.addEventListener('click', () => showPage(e.dataset.page)));
  $('connect-button').addEventListener('click', () => { $('token-input').value = ''; $('token-dialog').showModal(); });
  $('token-form').addEventListener('submit', async e => {
    e.preventDefault();
    const submitter = e.submitter;
    if (submitter && submitter.value === 'cancel') { $('token-dialog').close(); return; }
    const proposed = $('token-input').value.trim();
    if (proposed.length < 24) { toast('Token must be at least 24 characters'); return; }
    state.token = proposed;
    try { await fetchAll(); $('token-dialog').close(); $('token-input').value = ''; toast('Local control database connected'); }
    catch (error) { state.token = ''; state.connected = false; toast('Connection denied: ' + error.message); }
  });
  $('refresh-button').addEventListener('click', async () => {
    try { await fetchAll(); toast('Local data refreshed'); } catch (error) { toast('Refresh failed: ' + error.message); }
  });
  $('task-search').addEventListener('click', renderTasks);
  $('task-team').addEventListener('change', renderTasks);
  $('task-query').addEventListener('input', renderTasks);
  $('note-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (e.submitter && e.submitter.value === 'cancel') { $('note-dialog').close(); return; }
    const data = { kind: $('note-kind').value, target: $('note-target').value, actor: $('note-actor').value, note: $('note-text').value };
    try {
      if (data.kind === 'conflict' && $('triage-status').value) {
        await api('conflicts/' + encodeURIComponent(data.target) + '/triage', 'POST', { status: $('triage-status').value, actor: data.actor, note: data.note });
      } else await api('notes', 'POST', data);
      $('note-dialog').close(); await fetchAll(); toast('Recorded locally. Product acceptance remains NO-GO.');
    } catch (error) { toast('Not saved: ' + error.message); }
  });
  $('source-form').addEventListener('submit', async e => {
    e.preventDefault();
    try { const fields = new FormData(e.currentTarget); await api('sources', 'POST', Object.fromEntries(fields.entries()));
      e.currentTarget.reset(); await fetchAll(); toast('Unverified source observation recorded'); }
    catch (error) { toast('Observation rejected: ' + error.message); }
  });
  $('run-doctor').addEventListener('click', async () => {
    try { const d = await api('doctor'); $('doctor-output').textContent = d.health + ' | ' + d.release + ' | ' + (d.findings.length ? d.findings.join(', ') : 'Local consistency verified. Not externally attested.'); toast(d.health); }
    catch (error) { toast('Doctor failed: ' + error.message); }
  });
  $('export-button').addEventListener('click', () => {
    if (!state.connected) return;
    const data = { exported_at: new Date().toISOString(), mode: 'LOCAL_UNVERIFIED_SNAPSHOT',
      summary: state.summary, conflicts: state.conflicts, contracts: state.contracts,
      tasks: state.tasks, sources: state.sources, audit: state.audit };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = node('a'); a.href = url; a.download = 'OSGARD_M184_local_snapshot.json';
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const initial = window.location.hash.replace('#', '');
  if (['overview', 'tasks', 'conflicts', 'contracts', 'sources', 'audit'].includes(initial)) showPage(initial);
})();
