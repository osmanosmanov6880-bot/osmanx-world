/** Serialization for an explicit owner download; never used by public feeds. */
export const EXPORT_ROW_LIMIT = 10000;
export const EXPORT_BYTE_LIMIT = 8 * 1024 * 1024;

// Quote every field and preserve embedded CR/LF/quotes. Formula-looking strings
// become literal text in spreadsheet software, including whitespace prefixes.
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (typeof value === 'string' && (/^[\t\r\n]/.test(text) || /^[\s\uFEFF]*[=+\-@]/u.test(text))) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

const contactColumns = ['id','revision','day','name','category','person','channel','outcome','problem','nextStep','createdAt','updatedAt'];
const expenseColumns = ['id','revision','day','amountRub','amountKopecks','category','note','createdAt','updatedAt'];

export function serializeCommandExport(snapshot, format) {
  if (format === 'json') return JSON.stringify(snapshot, null, 2) + '\n';
  const columns = format === 'contacts.csv' ? contactColumns : format === 'expenses.csv' ? expenseColumns : null;
  if (!columns) throw new TypeError('Unsupported export format');
  const rows = format === 'contacts.csv' ? snapshot.contacts : snapshot.expenses;
  return '\uFEFF' + [columns.map(csvCell).join(','), ...rows.map(row => columns.map(key => csvCell(row[key])).join(','))].join('\r\n') + '\r\n';
}

export async function commandExportBytes(snapshot, format) {
  const bytes = new TextEncoder().encode(serializeCommandExport(snapshot, format));
  if (bytes.byteLength > EXPORT_BYTE_LIMIT) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const base64 = btoa(String.fromCharCode(...digest));
  return { bytes, contentDigest: 'sha-256=:' + base64 + ':', sha256: Array.from(digest, value => value.toString(16).padStart(2,'0')).join('') };
}
