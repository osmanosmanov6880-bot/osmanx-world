"use strict";
/* M187 local review desk. Nothing here changes GitHub or product acceptance. */
const SOURCE = "../recovery/ORIGINAL_180_TASKS.json";
const STORE_KEY = "osgard_supreme_director_m187_local_review_v1";
const STATUS = {
  BLOCKED_UPSTREAM: "Ожидает исходники",
  PLANNED: "Запланировано",
  IN_PROGRESS: "В работе",
  READY_FOR_REVIEW: "На независимой проверке"
};
const TEAM_LABELS = {
  TITAN: "TITAN", NEXUS: "NEXUS", COMMERCE: "COMMERCE",
  EXPERIENCE: "EXPERIENCE", GENESIS: "GENESIS", ORBITAL: "ORBITAL"
};
const $ = (id) => document.getElementById(id);
const state = { tasks: [], local: {}, view: "all", search: "", priority: "", status: "", currentId: "" };
function safeRead() {
  try {
    const value = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (_) { return {}; }
}
function persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.local)); }
  catch (_) { toast("Сохранение в браузере недоступно. Сделай экспорт."); }
}
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("visible");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => el.classList.remove("visible"), 3000);
}
function elem(name, className, content) {
  const item = document.createElement(name);
  if (className) item.className = className;
  if (content !== undefined) item.textContent = String(content);
  return item;
}
function localStatus(task) {
  const saved = state.local[task.id];
  return saved && STATUS[saved.status] ? saved.status : task.local_recovery_status || "BLOCKED_UPSTREAM";
}
function filtered() {
  const q = state.search.trim().toLocaleLowerCase("ru");
  return state.tasks.filter(t => {
    const status = localStatus(t);
    if (state.view === "blocked" && status !== "BLOCKED_UPSTREAM") return false;
    if (state.view === "review" && status !== "READY_FOR_REVIEW") return false;
    if (state.view.startsWith("team:") && t.team !== state.view.slice(5)) return false;
    if (state.view === "P0" && t.priority !== "P0") return false;
    if (state.priority && t.priority !== state.priority) return false;
    if (state.status && state.status !== status) return false;
    return !q || (t.id + " " + t.title + " " + t.team).toLocaleLowerCase("ru").includes(q);
  });
}
function renderNav() {
  const root = $("teamNav"); root.replaceChildren();
  for (const [name, label] of Object.entries(TEAM_LABELS)) {
    const btn = elem("button", "nav" + (state.view === "team:" + name ? " active" : ""), label);
    const count = elem("span", "", state.tasks.filter(t => t.team === name).length);
    btn.appendChild(count);
    btn.onclick = () => { state.view = "team:" + name; render(); };
    root.appendChild(btn);
  }
  document.querySelectorAll("[data-nav]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.nav === state.view);
    btn.onclick = () => { state.view = btn.dataset.nav; render(); };
  });
}
function render() {
  renderNav();
  $("total").textContent = state.tasks.length;
  // Cannot be changed by local notes. Original independent acceptance remains 0.
  $("verified").textContent = "0";
  $("progress").textContent = state.tasks.filter(t => localStatus(t) === "IN_PROGRESS").length;
  $("blocked").textContent = state.tasks.filter(t => localStatus(t) === "BLOCKED_UPSTREAM").length;
  const tasks = filtered();
  $("listCount").textContent = tasks.length + " записей";
  const list = $("taskList"); list.replaceChildren();
  if (!tasks.length) { list.appendChild(elem("div", "empty", "По выбранным условиям задач нет")); return; }
  const fragment = document.createDocumentFragment();
  for (const task of tasks) {
    const row = elem("button", "task");
    row.type = "button";
    row.setAttribute("aria-label", task.id + ": " + task.title);
    const name = elem("div", "");
    name.append(elem("div", "task-id", task.id), elem("div", "task-title", task.title));
    row.append(name, elem("div", "team", task.team));
    row.appendChild(elem("span", "chip " + task.priority.toLowerCase(), task.priority));
    const status = localStatus(task);
    row.appendChild(elem("span", "chip " + (status === "BLOCKED_UPSTREAM" ? "blocked" : status === "READY_FOR_REVIEW" ? "review" : ""), STATUS[status] || status));
    row.appendChild(elem("span", "arrow", "›"));
    row.onclick = () => openDetails(task.id);
    fragment.appendChild(row);
  }
  list.appendChild(fragment);
}
function detailField(root, label, value) {
  root.appendChild(elem("div", "detail-label", label));
  root.appendChild(elem("div", "detail-copy", value || "Не указано"));
}
function openDetails(id) {
  const task = state.tasks.find(x => x.id === id);
  if (!task) return;
  state.currentId = id;
  const root = $("taskDetails"); root.replaceChildren();
  root.append(elem("div", "detail-title", task.id + " · " + task.title));
  const chips = elem("div", "detail-sub");
  chips.append(elem("span", "chip", task.team), elem("span", "chip " + task.priority.toLowerCase(), task.priority));
  root.appendChild(chips);
  detailField(root, "ИСТОЧНИК", "Оригинальный мастер-план · строка " + (task.source_line || "?") + " · статус " + task.original_status);
  detailField(root, "ГРАНИЦЫ РАБОТ", task.edit_scope_ru);
  detailField(root, "ЗАВИСИМОСТИ", task.dependency_clause_ru);
  if (Array.isArray(task.explicit_deps) && task.explicit_deps.length) {
    root.appendChild(elem("div", "detail-label", "ССЫЛКИ НА ДРУГИЕ ЗАДАЧИ"));
    const dep = elem("div", "detail-links");
    task.explicit_deps.forEach(x => {
      const b = elem("button", "dep", x);
      b.onclick = () => openDetails(x);
      dep.appendChild(b);
    });
    root.appendChild(dep);
  }
  root.appendChild(elem("div", "notice", "Локальная отметка не подтверждает выполнение исходной задачи и не меняет статус независимой приёмки."));
  const local = state.local[id] || {};
  root.appendChild(elem("label", "detail-label", "ЛОКАЛЬНЫЙ СТАТУС"));
  const select = elem("select", "field"); select.id = "detailStatus";
  Object.entries(STATUS).forEach(([key, title]) => {
    const o = elem("option", "", title); o.value = key; select.appendChild(o);
  });
  select.value = localStatus(task); root.appendChild(select);
  const label = elem("label", "detail-label", "СВИДЕТЕЛЬСТВА И ЗАМЕТКИ");
  label.htmlFor = "detailNotes"; root.appendChild(label);
  const notes = elem("textarea", "field"); notes.id = "detailNotes"; notes.rows = 5;
  notes.placeholder = "Ссылка на коммит, тесты, проверенный источник, блокер...";
  notes.value = local.notes || ""; root.appendChild(notes);
  const save = elem("button", "btn", "Сохранить локальную запись");
  save.style.marginTop = "17px";
  save.onclick = () => {
    const nextStatus = select.value;
    const nextNotes = notes.value.trim();
    if (nextStatus === "READY_FOR_REVIEW" && !nextNotes) {
      toast("Для передачи на проверку укажи свидетельства.");
      notes.focus(); return;
    }
    state.local[id] = { status: nextStatus, notes: nextNotes, updated_at: new Date().toISOString() };
    persist(); $("taskDialog").close(); render(); toast("Локальная запись сохранена");
  };
  root.appendChild(save);
  $("taskDialog").showModal();
}
function exportJournal() {
  const out = {
    schema: "osgard.m187.local-review/1", simulation_only: true, production: false,
    original_accepted_tasks: 0, exported_at: new Date().toISOString(),
    source: "DIRECTOR_MASTER_180.md", local_records: state.local
  };
  const blob = new Blob([JSON.stringify(out, null, 2) + "\n"], { type: "application/json" });
  const uri = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = uri; link.download = "OSGARD_M187_LOCAL_REVIEW.json";
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(uri), 1000);
  toast("Экспорт готов. Данные не отправлялись на сервер.");
}
async function initialize() {
  state.local = safeRead();
  $("search").addEventListener("input", e => { state.search = e.target.value; render(); });
  $("priority").addEventListener("change", e => { state.priority = e.target.value; render(); });
  $("status").addEventListener("change", e => { state.status = e.target.value; render(); });
  $("closeDialog").onclick = () => $("taskDialog").close();
  $("exportBtn").onclick = exportJournal;
  try {
    const result = await fetch(SOURCE, { cache: "no-store" });
    if (!result.ok) throw Error("HTTP " + result.status);
    const data = await result.json();
    if (!Array.isArray(data.tasks) || data.tasks.length !== 180) throw Error("Ожидалось ровно 180 задач");
    const ids = new Set(data.tasks.map(t => t.id));
    if (ids.size !== 180) throw Error("Дублирующиеся ID в исходном плане");
    for (const item of data.tasks) if (!ids.has(item.id) || !Array.isArray(item.explicit_deps)) throw Error("Неверная структура записи");
    state.tasks = data.tasks; render();
  } catch (error) {
    $("taskList").replaceChildren(elem("div", "empty", "Не удалось загрузить исходный план: " + error.message + ". Запусти локальный HTTP-сервер из корня репозитория."));
    toast("Ошибка загрузки мастер-плана");
  }
}
initialize();
