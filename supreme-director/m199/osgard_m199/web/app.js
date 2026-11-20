"use strict";
/* Local data only. Token is kept in memory; server values use textContent. */
const app = { token: "", identity: null, report: null, calendar: null, request: 0 };
const $ = id => document.getElementById(id);
const el = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = String(value);
  return node;
};
const money = value => value == null ? "—" : new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 100) + " ₽";
const states = { planned: "Запланирован", active: "В работе", completed: "Завершён", cancelled: "Отменён" };
const risks = { BUDGET_NOT_SET: "Бюджет не задан", OVER_BUDGET: "Выше бюджета", RECEIVABLE_OVERDUE: "Просрочка", ON_PLAN: "По плану" };
function message(text) { const item = $("feedback"); item.textContent = text; item.hidden = !text; }
async function api(operation, payload = {}) {
  if (!app.token) throw new Error("Необходима авторизация");
  const response = await fetch("/v1/execute", {
    method: "POST", cache: "no-store",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + app.token },
    body: JSON.stringify({ operation, payload, idempotency_key: null })
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.message || data.error || "Ошибка запроса");
  return data.result;
}
function logout() {
  ++app.request; app.token = ""; app.identity = null; app.report = null; app.calendar = null;
  $("tokenInput").value = ""; $("workspace").hidden = true; $("loginView").hidden = false;
}
async function login(event) {
  event.preventDefault(); $("loginError").hidden = true;
  const input = $("tokenInput"); app.token = input.value;
  try {
    app.identity = await api("titan.session.get");
    input.value = ""; $("sessionName").textContent = app.identity.actor;
    $("sessionRole").textContent = app.identity.role === "owner" ? "Владелец" : app.identity.role === "operator" ? "Сотрудник" : "Просмотр";
    $("loginView").hidden = true; $("workspace").hidden = false;
    // Navigation to a different page requires logging in there again; tokens are not persisted.
    await refresh();
  } catch (error) {
    logout(); const text = $("loginError"); text.textContent = "Ошибка входа: " + error.message; text.hidden = false;
  }
}
function selectedFilters() {
  const result = {};
  const status = $("projectState").value;
  if (status) result.project_state = status;
  const date = $("asOf").value;
  if (date) {
    const seconds = Date.parse(date + "T00:00:00Z") / 1000;
    if (!Number.isSafeInteger(seconds)) throw new Error("Неверная дата");
    result.as_of = seconds;
  }
  return result;
}
async function refresh() {
  const id = ++app.request;
  $("refresh").disabled = true; $("export").disabled = true;
  message("Загружаю подтверждённые локальные данные…");
  try {
    const params = selectedFilters();
    const [overview, calendar] = await Promise.all([
      api("commerce.portfolio.overview", params),
      api("commerce.portfolio.calendar", { ...params, months: Number($("months").value) })
    ]);
    if (id !== app.request) return;
    app.report = overview; app.calendar = calendar;
    render(); message("");
  } catch (error) {
    if (id === app.request) message("Не удалось загрузить данные: " + error.message);
  } finally {
    if (id === app.request) { $("refresh").disabled = false; $("export").disabled = false; }
  }
}
function render() {
  const info = app.report.totals;
  $("budget").textContent = money(info.budget_minor || 0);
  $("actual").textContent = money(info.actual_cost_minor || 0);
  $("forecast").textContent = money(info.forecast_cost_minor || 0);
  $("pending").textContent = money(info.pending_receivables_minor || 0);
  $("coverage").textContent = info.project_count ? "Бюджет задан для " + info.projects_with_budget + " из " + info.project_count + " проектов" : "Проектов пока нет";
  $("projectCount").textContent = info.project_count + " проектов";
  renderTimeline(); renderProjects();
}
function renderTimeline() {
  const root = $("timeline"); root.replaceChildren();
  const buckets = app.calendar.buckets;
  const max = Math.max(1, ...buckets.flatMap(x => [x.pending_due_minor, x.manual_recorded_minor]));
  for (const entry of buckets) {
    const item = el("div", "month"), label = el("div", "month-label", entry.month), container = el("div", "bars");
    for (const [type, value] of [["future", entry.pending_due_minor], ["manual", entry.manual_recorded_minor]]) {
      const bar = el("div", "bar " + type), inside = el("i");
      inside.style.width = (100 * value / max) + "%";
      bar.appendChild(inside); bar.title = (type === "future" ? "Ожидается: " : "Учтено вручную: ") + money(value);
      container.appendChild(bar);
    }
    item.append(label, container, el("div", "month-amount", money(entry.pending_due_minor)));
    root.appendChild(item);
  }
  const exceptions = app.calendar.outside_horizon;
  $("overdue").textContent = money(exceptions.overdue_pending_minor || 0);
  $("undated").textContent = money(exceptions.undated_pending_minor || 0);
  $("future").textContent = money(exceptions.beyond_horizon_pending_minor || 0);
}
function renderProjects() {
  const root = $("projects"); root.replaceChildren();
  const list = app.report.projects;
  if (!list.length) {
    const tr = el("tr"), td = el("td", "empty", "Проекты с выбранными параметрами пока отсутствуют.");
    td.colSpan = 5; tr.appendChild(td); root.appendChild(tr); return;
  }
  for (const p of list) {
    const tr = el("tr"), one = el("td");
    one.append(el("span", "project-name", p.project_title), el("span", "project-customer", p.customer_name));
    const state = el("td"); state.appendChild(el("span", "pill", states[p.state] || p.state));
    const riskCell = el("td"); riskCell.appendChild(el("span", "pill " + (p.summary.risk === "ON_PLAN" ? "ok" : "risk"), risks[p.summary.risk] || p.summary.risk));
    tr.append(one, state, el("td", "", money(p.summary.budget_minor)), el("td", "", money(p.summary.forecast_cost_minor)), riskCell);
    root.appendChild(tr);
  }
}
async function exportCSV() {
  $("export").disabled = true;
  try {
    const result = await api("commerce.portfolio.export", selectedFilters());
    const file = new Blob([result.csv_text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(file), link = document.createElement("a");
    link.href = url; link.download = result.file_name;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message("CSV выгружен: " + result.row_count + " проектов. Это локальные записи, не банковская выписка.");
  } catch (error) { message("Не удалось экспортировать данные: " + error.message); }
  finally { $("export").disabled = false; }
}
$("loginForm").addEventListener("submit", login);
$("logout").addEventListener("click", logout);
$("refresh").addEventListener("click", refresh);
$("export").addEventListener("click", exportCSV);
for (const id of ["projectState", "asOf", "months"]) $(id).addEventListener("change", refresh);
