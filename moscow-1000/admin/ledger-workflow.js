/* Private ledger helpers. No browser storage, identity or network side effects. */
(function (root) {
  'use strict';
  const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
  const exportFormats = ['json', 'contacts.csv', 'expenses.csv'];
  const auditCategories = ['all', 'contact', 'expense', 'quest', 'publication', 'export'];
  function parseKopecks(value) {
    if (typeof value !== 'string' || value.length > 24) return null;
    const text = value.trim().replace(',', '.');
    if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(text)) return null;
    const [whole, fraction = ''] = text.split('.');
    const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    return Number.isSafeInteger(amount) && amount > 0 && amount <= 100000000 ? amount : null;
  }
  function money(kopecks) {
    return Number.isSafeInteger(kopecks) ? new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(kopecks / 100) : '—';
  }
  function amountInput(kopecks) {
    if (!Number.isSafeInteger(kopecks) || kopecks < 0) return '';
    return Math.trunc(kopecks / 100) + '.' + String(kopecks % 100).padStart(2, '0');
  }
  function expenseAmount(expense) {
    if (Number.isSafeInteger(expense?.amountKopecks)) return expense.amountKopecks;
    const value = expense?.amountRub, amount = Math.round(value * 100);
    return typeof value === 'number' && Number.isSafeInteger(amount) && Math.abs(value * 100 - amount) < 0.000001 ? amount : null;
  }
  function expenseBody({ day, amount, category, note }) {
    const kopecks = parseKopecks(amount);
    if (!Number.isInteger(day) || day < 1 || day > 10 || kopecks === null || typeof category !== 'string' || !category.trim() || category.trim().length > 80 || /[<>\u0000-\u001f\u007f]/.test(category) || typeof note !== 'string' || note.trim().length > 300 || /[<>\u0000-\u001f\u007f]/.test(note)) return null;
    return { day, amountRub: kopecks / 100, category: category.trim(), note: note.trim() };
  }
  function expenseQuery({ day, allDays = false, category = '' }, offset = 0) {
    const query = new URLSearchParams();
    if (!allDays && Number.isInteger(day) && day >= 1 && day <= 10) query.set('day', String(day));
    if (typeof category === 'string' && category && category.length <= 80) query.set('category', category);
    query.set('offset', String(Number.isSafeInteger(offset) && offset >= 0 ? offset : 0));
    return query.toString();
  }
  function expensePage(previous, data, append) {
    if (!data || !Array.isArray(data.expenses) || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.totalKopecks) || data.totalKopecks < 0 || !(data.nextOffset === null || Number.isSafeInteger(data.nextOffset) && data.nextOffset >= 0)) throw new Error('Сервер не передал полные итоги расходов. Обновите сервис штаба.');
    if (append && previous.revision !== data.revision) return { reload: true };
    const seen = new Set();
    const records = (append ? [...previous.records, ...data.expenses] : data.expenses).filter(row => {
      if (!row || typeof row.id !== 'string' || seen.has(row.id)) return false;
      seen.add(row.id); return true;
    });
    return { reload: false, records, revision: data.revision, total: data.total, totalKopecks: data.totalKopecks, nextOffset: data.nextOffset };
  }
  function exportFilename(format, now = new Date()) {
    if (!exportFormats.includes(format) || !Number.isFinite(now.getTime())) throw new Error('Неизвестный формат экспорта.');
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const suffix = format === 'json' ? 'COMMAND.json' : format === 'contacts.csv' ? 'CONTACTS.csv' : 'EXPENSES.csv';
    return 'OSMANX_' + stamp + '_' + suffix;
  }
  async function verifyExport(bytes, digest) {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > MAX_EXPORT_BYTES || !bytes.byteLength) throw new Error('Размер выгрузки недопустим. Файл не сохранён.');
    const match = /^sha-256=:([A-Za-z0-9+/]{43}=):$/.exec(String(digest || ''));
    if (!match) throw new Error('Сервер не передал контрольную сумму выгрузки. Файл не сохранён.');
    const hash = new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes));
    let raw = ''; for (const value of hash) raw += String.fromCharCode(value);
    if (root.btoa(raw) !== match[1]) throw new Error('Проверка файла не прошла. Повторите выгрузку.');
    return true;
  }
  function exportMetadata(headers) {
    const read = name => { const text = headers.get(name); return typeof text === 'string' && /^\d{1,12}$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null; };
    const result = { revision: read('X-Export-Revision'), contacts: read('X-Export-Contacts'), expenses: read('X-Export-Expenses'), quests: read('X-Export-Quests'), count: read('X-Export-Count') };
    if (Object.values(result).some(value => value === null)) throw new Error('Сервер не подтвердил состав выгрузки. Файл не сохранён.');
    return result;
  }
  function auditQuery(category, cursor) {
    const query = new URLSearchParams({ category: auditCategories.includes(category) ? category : 'all' });
    if (typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 2048) query.set('cursor', cursor);
    return query.toString();
  }
  const auditLabels = Object.freeze({
    command_contact_created: 'Добавлен контакт', command_contact_updated: 'Изменён контакт', command_contact_erased: 'Удалён контакт',
    command_expense_created: 'Добавлен расход', command_expense_updated: 'Изменён расход', command_expense_erased: 'Удалён расход',
    command_quest_changed: 'Обновлён результат квеста', command_aggregates_published: 'Опубликована сводка', command_aggregates_unpublished: 'Сводка снята с публикации',
    command_exported: 'Создана выгрузка данных', command_data_exported: 'Создана выгрузка данных'
  });
  root.OSMANXLedgerWorkflow = Object.freeze({ MAX_EXPORT_BYTES, parseKopecks, money, amountInput, expenseAmount, expenseBody, expenseQuery, expensePage, exportFilename, verifyExport, exportMetadata, auditQuery, auditLabels });
})(typeof window === 'undefined' ? globalThis : window);
