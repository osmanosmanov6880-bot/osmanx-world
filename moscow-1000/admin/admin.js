/* Private command UI. Authentication is verified by the server; no local bypass or stored tokens. */
(() => {
  'use strict';

  const API = '/moscow-1000/api';
  const $ = id => document.getElementById(id);
  const state = {
    actor: null, googleReady: false, day: 1, tab: 'contacts', contacts: [], expenses: [],
    contactOffset: null, expenseOffset: null, quests: [], editing: null,
    contactsSeq: 0, expensesSeq: 0, questsSeq: 0, authSeq: 0,
    confirmAction: null, confirmationBusy: false,
  };
  const titles = { contacts: 'Контакты', expenses: 'Расходы', quests: 'Квесты и стратегия', publish: 'Публикация' };
  const outcomes = { visited: 'Визит', dialogue: 'Диалог', interest: 'Интерес', refusal: 'Отказ', meeting: 'Встреча', pilot: 'Пилот', contract: 'Договор' };
  const categories = { HoReCa: 'Кафе и рестораны', retail: 'Магазины и шоурумы', services: 'Услуги', creative: 'Креативные студии', technology: 'Технологии', other: 'Другое' };
  const expenseCategories = { transport: 'Транспорт', food: 'Питание', production: 'Съёмка', tools: 'Инструменты', other: 'Другое' };
  const money = n => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(n);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function icon(name) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.classList.add('icon');
    node.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    node.append(use);
    return node;
  }

  function status(id, message = '', kind = '') {
    const node = $(id);
    node.textContent = message;
    node.className = 'status' + (kind ? ' ' + kind : '');
    node.hidden = !message;
  }

  function busyForm(form, busy) {
    for (const control of form.querySelectorAll('input,select,textarea,button')) {
      if (busy) {
        control.dataset.wasDisabled = control.disabled ? '1' : '0';
        control.disabled = true;
      } else {
        control.disabled = control.dataset.wasDisabled === '1';
        delete control.dataset.wasDisabled;
      }
    }
    form.setAttribute('aria-busy', String(busy));
  }

  async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(API + path, {
        method: options.method || 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: options.body !== undefined ? { 'Content-Type': 'application/json', 'Accept': 'application/json' } : { 'Accept': 'application/json' },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        redirect: 'error', signal: controller.signal,
      });
      let data = null;
      if ((response.headers.get('content-type') || '').includes('application/json')) {
        try { data = await response.json(); } catch { /* Handled as an invalid server response below. */ }
      }
      if (!response.ok || data?.ok === false || !data) {
        if (response.status === 401 && !path.startsWith('/auth/')) lock('Сессия завершилась. Войдите через Google ещё раз.');
        const message = response.status === 409
          ? 'Запись уже изменилась. Закройте форму, обновите список и повторите изменение.'
          : response.status === 403
            ? 'У этого аккаунта нет разрешения на действие.'
            : response.status === 503
              ? 'Сервис ещё не подключён или временно недоступен. Запись не сохранена.'
              : response.status === 404
                ? 'Сервис штаба не подключён к этому адресу.'
                : typeof data?.error === 'string' && data.error.length < 240
                  ? data.error
                  : 'Сервер не подтвердил действие. Попробуйте ещё раз.';
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Сервер не ответил вовремя. Проверьте соединение и повторите запрос.');
      if (error instanceof TypeError) throw new Error('Не удалось связаться со штабом. Проверьте подключение к интернету.');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function clearPrivateViews() {
    state.contactsSeq++; state.expensesSeq++; state.questsSeq++;
    state.contacts = []; state.expenses = []; state.quests = []; state.editing = null;
    for (const id of ['contactList', 'expenseList', 'questList']) $(id).replaceChildren();
    $('actorEmail').textContent = '';
    $('contactForm').reset();
    $('expenseForm').reset();
    $('publishConfirm').checked = false;
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  }

  function lock(message = '') {
    state.actor = null;
    clearPrivateViews();
    $('workspace').hidden = true;
    $('login').hidden = false;
    $('googleSignIn').disabled = !state.googleReady;
    if (message) status('authStatus', message, 'error');
  }

  async function bootstrap() {
    const seq = ++state.authSeq;
    $('googleSignIn').disabled = true;
    $('retryAuth').hidden = true;
    status('authStatus', 'Проверяем доступ…');
    const [config, session] = await Promise.allSettled([api('/auth/config'), api('/auth/session')]);
    if (seq !== state.authSeq) return;
    state.googleReady = config.status === 'fulfilled' && config.value.googleEnabled === true && config.value.configured === true;
    if (session.status === 'fulfilled' && session.value.authenticated === true && session.value.actor?.email) {
      state.actor = session.value.actor;
      $('login').hidden = true;
      $('workspace').hidden = false;
      $('actorEmail').textContent = state.actor.email;
      applyPermissions();
      await switchTab(state.tab);
      return;
    }
    lock();
    $('retryAuth').hidden = false;
    if (!state.googleReady) {
      status('authStatus', config.status === 'fulfilled'
        ? 'Вход через Google ещё не подключён. Пока настройка не завершена, личный штаб закрыт.'
        : 'Сервис входа недоступен по этому адресу. Личный штаб закрыт; попробуйте проверить доступ позже.', 'error');
    } else {
      const query = new URLSearchParams(location.search);
      const failedReturn = query.has('auth_error') || query.has('error');
      status('authStatus', failedReturn
        ? 'Вход не завершён. Убедитесь, что выбран аккаунт с доступом к штабу, и повторите попытку.'
        : 'Вход откроется на защищённой странице Google.', failedReturn ? 'error' : '');
    }
  }

  function applyPermissions() {
    const canEdit = state.actor?.editor === true;
    $('newContact').disabled = !canEdit;
    for (const node of $('expenseForm').querySelectorAll('input,select,button')) node.disabled = !canEdit;
    $('publishConfirm').disabled = state.actor?.approver !== true;
    $('publish').disabled = state.actor?.approver !== true || !$('publishConfirm').checked;
    $('unpublish').disabled = state.actor?.approver !== true;
    if (!canEdit) status('workspaceStatus', 'Для этого аккаунта открыт просмотр. Изменять записи может редактор.');
  }

  async function switchTab(tab) {
    if (!state.actor || !Object.hasOwn(titles, tab)) return;
    state.tab = tab;
    $('sectionHeading').textContent = titles[tab];
    for (const name of Object.keys(titles)) $(name + 'Panel').hidden = name !== tab;
    for (const button of document.querySelectorAll('[data-tab]')) {
      const active = button.dataset.tab === tab;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    document.querySelector('.day-control').hidden = tab === 'publish';
    status('workspaceStatus');
    applyPermissions();
    if (tab === 'contacts') await loadContacts();
    if (tab === 'expenses') await loadExpenses();
    if (tab === 'quests') await loadQuests();
    if (tab === 'publish' && state.actor?.approver !== true) status('publishStatus', 'Публиковать сводку может только аккаунт с правом подтверждения.', 'error');
  }

  function emptyView(container, name, title, description, retry) {
    const block = el('div', 'empty-state');
    block.append(icon(name), el('h3', '', title), el('p', '', description));
    if (retry) {
      const button = el('button', 'secondary-button', 'Повторить');
      button.type = 'button';
      button.addEventListener('click', retry);
      block.append(button);
    }
    container.replaceChildren(block);
  }

  function dateLabel(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(date);
  }

  function actionButton(name, title, handler, danger = false) {
    const button = el('button', 'icon-button' + (danger ? ' danger' : ''));
    button.type = 'button';
    button.setAttribute('aria-label', title);
    button.title = title;
    button.append(icon(name));
    button.disabled = state.actor?.editor !== true;
    button.addEventListener('click', handler);
    return button;
  }

  function detail(parent, label, value) {
    if (!value) return;
    const line = el('p', 'record-detail');
    line.append(el('strong', '', label + ': '), document.createTextNode(value));
    parent.append(line);
  }

  async function loadContacts(append = false) {
    if (!state.actor) return;
    const seq = ++state.contactsSeq;
    const day = state.day;
    const offset = append ? state.contactOffset : 0;
    if (append && offset === null) return;
    $('moreContacts').disabled = true;
    if (!append) {
      $('contactCount').textContent = '—';
      $('moreContacts').hidden = true;
      emptyView($('contactList'), 'users', 'Загрузка контактов', 'Получаем сохранённые записи штаба.');
    }
    try {
      const data = await api(`/command/contacts?day=${day}&offset=${offset || 0}`);
      if (seq !== state.contactsSeq || !state.actor) return;
      if (!Array.isArray(data.contacts)) throw new Error('Не удалось прочитать список контактов.');
      state.contacts = append ? [...state.contacts, ...data.contacts] : data.contacts;
      state.contactOffset = Number.isInteger(data.nextOffset) ? data.nextOffset : null;
      renderContacts();
    } catch (error) {
      if (seq !== state.contactsSeq || !state.actor) return;
      if (!append) emptyView($('contactList'), 'users', 'Контакты не загружены', error.message, () => loadContacts());
      else status('workspaceStatus', error.message, 'error');
    } finally { if (seq === state.contactsSeq) $('moreContacts').disabled = false; }
  }

  function renderContacts() {
    const list = $('contactList');
    list.replaceChildren();
    $('contactCount').textContent = state.contacts.length + (state.contactOffset !== null ? '+' : '');
    $('moreContacts').hidden = state.contactOffset === null;
    if (!state.contacts.length) {
      emptyView(list, 'users', 'Пока нет контактов', `Запишите первый диалог за день ${state.day}. Контакт будет виден только в личном штабе.`);
      return;
    }
    for (const contact of state.contacts) {
      const card = el('article', 'record-card');
      const top = el('div', 'record-top');
      const head = el('div');
      head.append(el('h3', '', contact.name), el('p', 'record-category', categories[contact.category] || contact.category || 'Без категории'));
      const outcome = el('span', 'outcome-pill', outcomes[contact.outcome] || 'Визит');
      outcome.dataset.outcome = contact.outcome;
      top.append(head, outcome);
      card.append(top);
      detail(card, 'Контакт', contact.person);
      detail(card, 'Связь', contact.channel);
      detail(card, 'Запрос', contact.problem);
      detail(card, 'Далее', contact.nextStep);
      const footer = el('div', 'record-footer');
      const time = el('time', '', dateLabel(contact.updatedAt || contact.createdAt));
      if (contact.updatedAt || contact.createdAt) time.dateTime = contact.updatedAt || contact.createdAt;
      const actions = el('div', 'record-actions');
      actions.append(actionButton('edit', `Изменить контакт «${contact.name}»`, () => openContact(contact)), actionButton('trash', `Удалить контакт «${contact.name}»`, () => confirmDeleteContact(contact), true));
      footer.append(time, actions);
      card.append(footer);
      list.append(card);
    }
  }

  function setContactMode(detailed) {
    $('quickMode').classList.toggle('active', !detailed);
    $('detailMode').classList.toggle('active', detailed);
    $('quickMode').setAttribute('aria-pressed', String(!detailed));
    $('detailMode').setAttribute('aria-pressed', String(detailed));
    $('detailedFields').hidden = !detailed;
    $('extraOutcomes').hidden = !detailed;
    if (!detailed) {
      const checked = $('contactForm').querySelector('input[name=outcome]:checked');
      if (checked && !['dialogue', 'interest', 'refusal'].includes(checked.value)) {
        // Preserve an edited outcome even when the optional detail fields are folded.
        $('extraOutcomes').hidden = false;
      }
    }
  }

  function openContact(contact = null) {
    if (state.actor?.editor !== true) return;
    state.editing = contact;
    $('contactForm').reset();
    $('contactName').setCustomValidity('');
    status('contactFormStatus');
    $('contactTitle').textContent = contact ? 'Изменить контакт' : 'Новый контакт';
    $('saveContact').querySelector('span').textContent = contact ? 'Сохранить изменения' : 'Сохранить контакт';
    $('contactName').value = contact?.name || '';
    $('contactPerson').value = contact?.person || '';
    $('contactChannel').value = contact?.channel || '';
    $('contactProblem').value = contact?.problem || '';
    $('contactNextStep').value = contact?.nextStep || '';
    $('contactDay').value = String(contact?.day || state.day);
    const category = contact?.category || '';
    for (const option of $('contactCategory').querySelectorAll('[data-custom]')) option.remove();
    if (category && ![...$('contactCategory').options].some(option => option.value === category)) {
      const option = new Option(category, category);
      option.dataset.custom = 'true';
      $('contactCategory').add(option);
    }
    $('contactCategory').value = category;
    const outcome = Object.hasOwn(outcomes, contact?.outcome) ? contact.outcome : 'dialogue';
    for (const radio of $('contactForm').querySelectorAll('input[name=outcome]')) radio.checked = radio.value === outcome;
    setContactMode(!!contact?.channel || !['dialogue', 'interest', 'refusal'].includes(outcome));
    $('contactDialog').showModal();
    $('contactName').focus();
  }

  async function saveContact(event) {
    event.preventDefault();
    if (state.actor?.editor !== true || $('saveContact').disabled) return;
    const form = $('contactForm');
    $('contactName').value = $('contactName').value.trim();
    $('contactName').setCustomValidity($('contactName').value ? '' : 'Укажите название или формат бизнеса.');
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form));
    const body = {
      day: Number(data.day), name: data.name.trim(), category: data.category,
      person: data.person.trim(), channel: data.channel.trim(), outcome: data.outcome,
      problem: data.problem.trim(), nextStep: data.nextStep.trim(),
    };
    const editing = state.editing;
    if (editing) body.expectedRevision = editing.revision;
    busyForm(form, true);
    status('contactFormStatus', 'Сохраняем контакт…');
    try {
      await api('/command/contacts' + (editing ? '/' + encodeURIComponent(editing.id) : ''), { method: editing ? 'PATCH' : 'POST', body });
      $('contactDialog').close();
      state.editing = null;
      status('workspaceStatus', 'Контакт сохранён в личном штабе.', 'success');
      await loadContacts();
    } catch (error) { status('contactFormStatus', error.message, 'error'); }
    finally { busyForm(form, false); }
  }

  function confirmation(title, description, actionLabel, action) {
    if (state.confirmationBusy) return;
    $('confirmTitle').textContent = title;
    $('confirmDescription').textContent = description;
    $('confirmAction').textContent = actionLabel;
    status('confirmStatus');
    state.confirmAction = action;
    $('confirmDialog').showModal();
    $('confirmDialog').querySelector('[data-close]').focus();
  }

  function confirmDeleteContact(contact) {
    confirmation('Удалить контакт?', `«${contact.name}» будет удалён из личного штаба. Восстановление этой записи не предусмотрено. Опубликованная сводка изменится только после следующей публикации.`, 'Удалить', async () => {
      await api('/command/contacts/' + encodeURIComponent(contact.id), { method: 'DELETE', body: { expectedRevision: contact.revision } });
      await loadContacts();
      status('workspaceStatus', 'Контакт удалён.', 'success');
    });
  }

  async function loadExpenses(append = false) {
    if (!state.actor) return;
    const seq = ++state.expensesSeq;
    const offset = append ? state.expenseOffset : 0;
    if (append && offset === null) return;
    $('moreExpenses').disabled = true;
    if (!append) {
      $('expenseTotal').textContent = '—'; $('expenseTotalNote').textContent = 'Загрузка записей';
      $('expenseCount').textContent = '—'; $('moreExpenses').hidden = true;
      emptyView($('expenseList'), 'wallet', 'Загрузка расходов', 'Получаем записи за выбранный день.');
    }
    try {
      const data = await api(`/command/expenses?day=${state.day}&offset=${offset || 0}`);
      if (seq !== state.expensesSeq || !state.actor) return;
      if (!Array.isArray(data.expenses)) throw new Error('Не удалось прочитать список расходов.');
      state.expenses = append ? [...state.expenses, ...data.expenses] : data.expenses;
      state.expenseOffset = Number.isInteger(data.nextOffset) ? data.nextOffset : null;
      renderExpenses();
    } catch (error) {
      if (seq !== state.expensesSeq || !state.actor) return;
      if (!append) {
        $('expenseTotalNote').textContent = 'Данные не загружены';
        emptyView($('expenseList'), 'wallet', 'Расходы не загружены', error.message, () => loadExpenses());
      } else status('workspaceStatus', error.message, 'error');
    } finally { if (seq === state.expensesSeq) $('moreExpenses').disabled = false; }
  }

  function renderExpenses() {
    const list = $('expenseList'); list.replaceChildren();
    const total = state.expenses.reduce((sum, expense) => sum + Math.round(Number(expense.amountRub) * 100), 0) / 100;
    $('expenseTotal').textContent = money(total);
    $('expenseTotalNote').textContent = state.expenseOffset === null
      ? `Все сохранённые расходы · день ${state.day}`
      : `Сумма ${state.expenses.length} загруженных записей · загрузите остальные ниже`;
    $('expenseCount').textContent = state.expenses.length + (state.expenseOffset !== null ? '+' : '');
    $('moreExpenses').hidden = state.expenseOffset === null;
    if (!state.expenses.length) { emptyView(list, 'wallet', 'Расходов пока нет', 'Добавьте расход через форму выше. Сумма попадёт в открытую сводку после публикации.'); return; }
    for (const expense of state.expenses) {
      const card = el('article', 'record-card');
      const top = el('div', 'record-top');
      top.append(el('h3', '', expenseCategories[expense.category] || expense.category || 'Другое'), el('span', 'expense-price', money(Number(expense.amountRub))));
      card.append(top);
      if (expense.note) card.append(el('p', 'record-detail', expense.note));
      const footer = el('div', 'record-footer');
      const time = el('time', '', dateLabel(expense.createdAt));
      if (expense.createdAt) time.dateTime = expense.createdAt;
      footer.append(time, actionButton('trash', `Удалить расход ${money(Number(expense.amountRub))}`, () => confirmation('Удалить расход?', `Запись на ${money(Number(expense.amountRub))} будет удалена из личного штаба.`, 'Удалить', async () => {
        await api('/command/expenses/' + encodeURIComponent(expense.id), { method: 'DELETE', body: {} });
        await loadExpenses(); status('workspaceStatus', 'Расход удалён.', 'success');
      }), true));
      card.append(footer); list.append(card);
    }
  }

  async function saveExpense(event) {
    event.preventDefault();
    if (state.actor?.editor !== true || $('saveExpense').disabled) return;
    const form = $('expenseForm');
    if (!form.reportValidity()) return;
    const body = { day: state.day, amountRub: Number($('expenseAmount').value), category: $('expenseCategory').value, note: $('expenseNote').value.trim() };
    busyForm(form, true); status('expenseFormStatus', 'Сохраняем расход…');
    try {
      await api('/command/expenses', { method: 'POST', body });
      form.reset(); status('expenseFormStatus', 'Расход сохранён.', 'success');
      await loadExpenses();
    } catch (error) { status('expenseFormStatus', error.message, 'error'); }
    finally { busyForm(form, false); }
  }

  async function loadQuests() {
    if (!state.actor) return;
    const seq = ++state.questsSeq;
    $('questComplete').textContent = '— / 5'; $('questXp').textContent = '— XP';
    document.querySelector('.quest-ring').style.setProperty('--progress', '0');
    emptyView($('questList'), 'target', 'Загрузка квестов', 'Получаем сохранённые результаты.');
    try {
      const data = await api('/command/quests');
      if (seq !== state.questsSeq || !state.actor) return;
      if (!Array.isArray(data.quests)) throw new Error('Не удалось прочитать результаты квестов.');
      state.quests = data.quests; renderQuests();
    } catch (error) {
      if (seq === state.questsSeq && state.actor) emptyView($('questList'), 'target', 'Квесты не загружены', error.message, () => loadQuests());
    }
  }

  function renderQuests() {
    const definitions = window.OSMANXCommandData?.quests(state.day);
    if (!Array.isArray(definitions) || !definitions.length) {
      emptyView($('questList'), 'target', 'Список задач недоступен', 'Обновите страницу, чтобы загрузить задачи экспедиции.'); return;
    }
    const done = new Set(state.quests.filter(quest => quest.day === state.day && quest.completed === true).map(quest => quest.questId));
    const completed = definitions.filter(quest => done.has(quest.id));
    $('questComplete').textContent = `${completed.length} / ${definitions.length}`;
    $('questXp').textContent = `${completed.reduce((sum, quest) => sum + quest.xp, 0)} XP`;
    document.querySelector('.quest-ring').style.setProperty('--progress', String(100 * completed.length / definitions.length));
    const list = $('questList'); list.replaceChildren();
    for (const quest of definitions) {
      const row = el('label', 'quest-row');
      const mark = el('span', 'quest-icon'); mark.append(icon('target'));
      const title = el('span', 'quest-copy', quest.title);
      const reward = el('span', 'quest-reward', '+' + quest.xp + ' XP');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = done.has(quest.id);
      checkbox.disabled = state.actor?.editor !== true;
      checkbox.setAttribute('aria-label', quest.title);
      checkbox.addEventListener('change', async () => {
        const day = state.day; const completed = checkbox.checked; checkbox.disabled = true;
        try {
          await api('/command/quests', { method: 'PUT', body: { day, questId: quest.id, completed } });
          state.quests = state.quests.filter(item => !(item.day === day && item.questId === quest.id));
          state.quests.push({ day, questId: quest.id, completed });
          if (state.actor && state.day === day && state.tab === 'quests') renderQuests();
          status('workspaceStatus', 'Результат квеста сохранён.', 'success');
        } catch (error) { checkbox.checked = !completed; checkbox.disabled = state.actor?.editor !== true; status('workspaceStatus', error.message, 'error'); }
      });
      row.append(mark, title, reward, checkbox); list.append(row);
    }
  }

  async function publish() {
    if (state.actor?.approver !== true || !$('publishConfirm').checked || $('publish').disabled) return;
    $('publish').disabled = true; $('publishConfirm').disabled = true;
    status('publishStatus', 'Обновляем открытую сводку…');
    try {
      await api('/command/publish', { method: 'POST', body: { confirm: true } });
      $('publishConfirm').checked = false;
      status('publishStatus', 'Сводка опубликована. Зрители видят обновлённые общие результаты за все дни.', 'success');
    } catch (error) { status('publishStatus', error.message, 'error'); }
    finally { $('publishConfirm').disabled = state.actor?.approver !== true; $('publish').disabled = state.actor?.approver !== true || !$('publishConfirm').checked; }
  }

  $('googleSignIn').addEventListener('click', () => {
    if (!state.googleReady) return;
    $('googleSignIn').disabled = true;
    status('authStatus', 'Переходим к входу через Google…');
    location.assign(API + '/auth/google/start');
  });
  $('retryAuth').addEventListener('click', bootstrap);
  $('logout').addEventListener('click', async () => {
    $('logout').disabled = true;
    try { await api('/auth/logout', { method: 'POST', body: {} }); lock('Вы вышли из личного штаба.'); }
    catch (error) { status('workspaceStatus', error.message, 'error'); }
    finally { $('logout').disabled = false; }
  });
  for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => switchTab(button.dataset.tab));
  $('activeDay').addEventListener('change', () => { state.day = Number($('activeDay').value); switchTab(state.tab); });
  $('newContact').addEventListener('click', () => openContact());
  $('quickMode').addEventListener('click', () => setContactMode(false));
  $('detailMode').addEventListener('click', () => setContactMode(true));
  $('contactName').addEventListener('input', () => $('contactName').setCustomValidity(''));
  $('contactForm').addEventListener('submit', saveContact);
  $('expenseForm').addEventListener('submit', saveExpense);
  $('moreContacts').addEventListener('click', () => loadContacts(true));
  $('moreExpenses').addEventListener('click', () => loadExpenses(true));
  $('publishConfirm').addEventListener('change', () => { $('publish').disabled = state.actor?.approver !== true || !$('publishConfirm').checked; });
  $('publish').addEventListener('click', publish);
  $('unpublish').addEventListener('click', () => {
    if (state.actor?.approver !== true) return;
    confirmation('Снять сводку с публикации?', 'Зрители больше не увидят опубликованные показатели. Контакты, расходы и результаты квестов останутся в штабе.', 'Снять', async () => {
      await api('/command/unpublish', { method: 'POST', body: {} });
      status('publishStatus', 'Сводка снята с публикации. Записи штаба сохранены.', 'success');
    });
  });
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => {
    if (button.dataset.close === 'confirmDialog' && state.confirmationBusy) return;
    if (button.dataset.close === 'contactDialog' && $('contactForm').getAttribute('aria-busy') === 'true') return;
    $(button.dataset.close).close();
  });
  $('contactDialog').addEventListener('cancel', event => { if ($('contactForm').getAttribute('aria-busy') === 'true') event.preventDefault(); });
  $('confirmDialog').addEventListener('cancel', event => { if (state.confirmationBusy) event.preventDefault(); });
  $('confirmAction').addEventListener('click', async () => {
    if (!state.confirmAction || state.confirmationBusy) return;
    state.confirmationBusy = true; $('confirmAction').disabled = true;
    for (const button of $('confirmDialog').querySelectorAll('[data-close]')) button.disabled = true;
    status('confirmStatus', 'Выполняем действие…');
    try { await state.confirmAction(); $('confirmDialog').close(); state.confirmAction = null; }
    catch (error) { status('confirmStatus', error.message, 'error'); }
    finally {
      state.confirmationBusy = false; $('confirmAction').disabled = false;
      for (const button of $('confirmDialog').querySelectorAll('[data-close]')) button.disabled = false;
    }
  });
  window.addEventListener('pagehide', () => { state.authSeq++; lock(); });
  window.addEventListener('pageshow', event => { if (event.persisted) bootstrap(); });
  bootstrap();
})();
