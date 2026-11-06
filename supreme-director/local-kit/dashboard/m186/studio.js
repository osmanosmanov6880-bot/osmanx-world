'use strict';
(() => {
  const state = { token: '', connected: false, summary: null, tasks: [], conflicts: [], contracts: [], sources: [], audit: [], evidence: [], reviewCases: [], reviewers: [], voteChallenge: null, labRuns: [], labCatalog: null, page: 'overview' };
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
    const [summary, tasks, conflicts, contracts, sources, audit, evidence, reviewCases, reviewers, labRuns, labCatalog] = await Promise.all([
      api('summary'), api('tasks'), api('conflicts'), api('contracts'), api('sources'), api('audit'),
      api('evidence'), api('reviews/cases'), api('reviews/reviewers'), api('lab/runs'), api('lab/catalog')]);
    state.summary = summary; state.tasks = tasks; state.conflicts = conflicts; state.contracts = contracts;
    state.sources = sources; state.audit = audit; state.evidence = evidence; state.reviewCases = reviewCases; state.reviewers = reviewers;
    state.labRuns = labRuns; state.labCatalog = labCatalog;
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
  function renderAll() { renderOverview(); renderTasks(); renderConflicts(); renderContracts(); renderSources(); renderAudit(); renderReviews(); renderLab(); }
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
      tasks: state.tasks, sources: state.sources, audit: state.audit,
      evidence: state.evidence, reviewCases: state.reviewCases, trustedPublicKeyFingerprints: state.reviewers };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = node('a'); a.href = url; a.download = 'OSGARD_M186_reference_snapshot.json';
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  function resetVote() {
    state.voteChallenge = null;
    $('vote-challenge').value = '';
    $('vote-signature').value = '';
    $('download-challenge').disabled = true;
    $('submit-vote').disabled = true;
  }
  function renderReviews() {
    $('review-stat-files').textContent = state.evidence.length;
    $('review-stat-open').textContent = state.reviewCases.filter(c => c.state === 'AWAITING_LOCAL_REVIEW').length;
    $('review-stat-signed').textContent = state.reviewCases.filter(c => c.state === 'SIGNED_LOCAL_REVIEW').length;
    $('review-stat-keys').textContent = state.reviewers.length;
    const list = $('review-evidence-list'); empty(list);
    if (!state.evidence.length) list.append(node('div', 'placeholder', 'No evidence files registered yet.'));
    state.evidence.forEach(item => {
      const e = node('div', 'review-file');
      e.append(node('b', '', '#' + item.id + ' / ' + item.target));
      e.append(node('small', '', item.relative_path + ' · SHA ' + item.sha256.slice(0, 12) + '…'));
      e.append(node('span', 'soft-tag', 'LOCAL SHA ONLY'));
      list.append(e);
    });
    const cases = $('review-case-list'); empty(cases);
    if (!state.reviewCases.length) cases.append(node('div', 'placeholder', 'No review cases created. Create one from a registered local file.'));
    state.reviewCases.forEach(c => {
      const e = node('div', 'review-case');
      const head = node('div', 'review-case-head');
      head.append(node('b', 'mono', c.id));
      head.append(node('span', 'soft-tag' + (c.state === 'SIGNED_LOCAL_REVIEW' ? '' : ' amber'), c.state.replaceAll('_',' ')));
      e.append(head); e.append(node('small', '', 'Evidence #' + c.evidence_id + ' · ' + c.target + ' · proposer: ' + c.proposer));
      e.append(node('p', '', c.description));
      if (c.verdict) e.append(node('small', '', 'Reviewer ' + c.reviewer_id + ' · ' + c.verdict + ' · ' + c.reason));
      cases.append(e);
    });
    const selCase = $('vote-case'); const previousCase = selCase.value; empty(selCase);
    selCase.append(new Option('Select an open case', ''));
    state.reviewCases.filter(c => c.state === 'AWAITING_LOCAL_REVIEW').forEach(c => selCase.append(new Option(c.id + ' / #' + c.evidence_id, c.id)));
    if ([...selCase.options].some(o => o.value === previousCase)) selCase.value = previousCase;
    const selReviewer = $('vote-reviewer'); const previousReviewer = selReviewer.value; empty(selReviewer);
    selReviewer.append(new Option(state.reviewers.length ? 'Choose trusted public key' : 'No trusted keys configured', ''));
    state.reviewers.forEach(r => selReviewer.append(new Option(r.id + ' · ' + r.role + ' · ' + r.key_sha256.slice(0, 10), r.id)));
    if ([...selReviewer.options].some(o => o.value === previousReviewer)) selReviewer.value = previousReviewer;
  }
  function saveJSON(value, filename) {
    const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], {type: 'application/json'});
    const url = URL.createObjectURL(blob); const a = node('a'); a.href = url; a.download = filename;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('review-evidence-form').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      const data = Object.fromEntries(new FormData(form).entries());
      const result = await api('evidence','POST',data);
      form.reset(); await fetchAll(); toast('Pinned local file #' + result.id + ' (not source verified)');
    } catch (error) { toast('Evidence blocked: ' + error.message); }
  });
  $('review-case-form').addEventListener('submit', async e => {
    e.preventDefault(); const form = e.currentTarget;
    try {
      const data = Object.fromEntries(new FormData(form).entries());
      data.evidence_id = Number(data.evidence_id);
      const result = await api('reviews/cases','POST',data);
      form.reset(); await fetchAll(); $('vote-case').value = result.case_id;
      resetVote(); toast('Immutable review case created. Independent review not yet completed.');
    } catch (error) { toast('Case blocked: ' + error.message); }
  });
  for (const id of ['vote-case','vote-reviewer','vote-verdict','vote-reason']) {
    $(id).addEventListener(id === 'vote-reason' ? 'input' : 'change', resetVote);
  }
  $('prepare-challenge').addEventListener('click', async () => {
    try {
      const data = {case_id:$('vote-case').value, reviewer_id:$('vote-reviewer').value,
        verdict:$('vote-verdict').value, reason:$('vote-reason').value};
      if (!data.case_id || !data.reviewer_id || !data.reason.trim()) throw new Error('Select case, trusted reviewer, and give a reason');
      const result = await api('reviews/challenge','POST',data);
      state.voteChallenge = result;
      $('vote-challenge').value = JSON.stringify(result, null, 2);
      $('download-challenge').disabled = false;
      $('submit-vote').disabled = false;
      toast('Review challenge ready. Only an external reviewer can sign it.');
    } catch (error) { resetVote(); toast('Challenge blocked: ' + error.message); }
  });
  $('download-challenge').addEventListener('click', () => {
    if (state.voteChallenge) saveJSON(state.voteChallenge, state.voteChallenge.case_id + '_challenge.json');
  });
  $('submit-vote').addEventListener('click', async () => {
    if (!state.voteChallenge) return;
    try {
      const p = state.voteChallenge;
      const r = await api('reviews/submit','POST',{
        case_id:p.case_id, reviewer_id:p.reviewer_id, verdict:p.verdict, reason:p.reason,
        signature_b64:$('vote-signature').value.trim()});
      resetVote(); await fetchAll(); toast(r.state + ' / product acceptance still 0');
    } catch (error) { toast('Signature refused: ' + error.message); }
  });

  
  function paintLabTrace(detail) {
    const trace = $('lab-trace'); empty(trace);
    if (!detail || !detail.events) return;
    for (const item of detail.events) {
      const e = item.event;
      const line = node('div', 'lab-step' + (e.status === 'BLOCKED_SCHEMA' ? ' failed' : ''));
      const id = node('span', 'lab-step-number', String(e.index).padStart(2,'0'));
      const copy = node('div','lab-step-body');
      copy.append(node('b','',e.contract_id + '  /  ' + e.producer + ' → ' + e.consumer));
      copy.append(node('small','',e.status + ' · ' + e.reason));
      const hash = node('code','', 'Output SHA ' + e.output_sha256.slice(0,24) + '…');
      copy.append(hash); line.append(id,copy); trace.append(line);
    }
  }
  async function loadLabRun(runId) {
    try {
      const detail = await api('lab/runs/' + encodeURIComponent(runId));
      $('lab-receipt').textContent = detail.run.outcome + ' · ' + detail.run.run_id + ' · ' + detail.run.release;
      paintLabTrace(detail);
    } catch (error) { toast('Run receipt unavailable: ' + error.message); }
  }
  function renderLab() {
    if (!state.summary) return;
    $('lab-count').textContent = String(state.summary.reference_runs || 0);
    $('lab-complete').textContent = String(state.summary.reference_complete || 0);
    $('lab-blocked').textContent = String(state.summary.reference_blocked || 0);
    const list = $('lab-history-list'); empty(list);
    if (!state.labRuns.length) {
      list.append(node('div','placeholder','No reference executions yet. Run a test scenario above.'));
      return;
    }
    state.labRuns.forEach(r => {
      const entry = node('button','lab-history-entry'); entry.type = 'button';
      entry.append(node('b','',r.run_id),node('span',r.outcome === 'REFERENCE_FLOW_COMPLETE' ? 'soft-tag' : 'soft-tag amber',r.outcome));
      entry.append(node('small','',r.at + '  /  ' + r.actor + '  /  ' + r.release));
      entry.addEventListener('click',()=>loadLabRun(r.run_id));list.append(entry);
    });
  }
  $('lab-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!state.connected) {toast('Connect to local reference database first');return;}
    const req = {scenario:$('lab-scenario').value, operator:$('lab-operator').value.trim(),
      budget_points:Number($('lab-budget').value), risk_profile:'PUBLIC_DEMO_ONLY',
      inject_fault_at:$('lab-fault').value || null};
    const button=$('lab-execute');button.disabled=true;
    try {
      const saved=await api('lab/runs','POST',req);
      await fetchAll();
      await loadLabRun(saved.run_id);
      toast(saved.result.outcome + ' — no live integrations');
    } catch (error) {toast('Reference execution blocked: ' + error.message);}
    finally {button.disabled=false;}
  });

  const initial = window.location.hash.replace('#', '');
  if (['overview', 'tasks', 'conflicts', 'contracts', 'sources', 'reviews', 'lab', 'audit'].includes(initial)) showPage(initial);
})();
