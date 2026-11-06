// 导入导出字段适配：在客户端完成 CSV 映射，后端只接收结构化条目（vault_import_items）。
// 支持 Bitwarden / 1Password / Chrome·Edge / KeePass 四种主流导出格式，按表头特征自动识别。
// 解析必须容忍真实导出的脏数据：BOM、CRLF、引号内换行、字段内逗号、空行。

import { blankItem, type VaultItem } from './api';

export interface ParsedImport {
  format: string;
  items: VaultItem[];
  skipped: number;
}

const CSV_SPECIAL = /[",\n\r]/;

export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // CRLF 的 CR 直接丢弃
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

function escapeCsv(value: string): string {
  if (!CSV_SPECIAL.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function toCsv(headers: string[], rows: string[][]): string {
  return [headers.map(escapeCsv).join(','), ...rows.map((r) => r.map(escapeCsv).join(','))].join('\r\n');
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, '_');
}

function pick(row: string[], idx: number): string {
  return idx >= 0 && idx < row.length ? row[idx].trim() : '';
}

/** otpauth://totp/Label?secret=XXXX&issuer=Y → XXXX */
export function totpSecretOf(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (!value.toLowerCase().startsWith('otpauth://')) return value;
  const m = /[?&]secret=([^&]+)/i.exec(value);
  return m ? decodeURIComponent(m[1]) : '';
}

function splitUrls(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function baseItem(title: string, username: string, password: string, urls: string[], notes: string): VaultItem {
  const item = blankItem('login');
  item.title = title;
  item.username = username;
  item.password = password;
  item.urls = urls;
  item.notes = notes;
  return item;
}

function mapRow(headers: string[], row: string[], format: string): VaultItem | null {
  const idx = (...names: string[]): number => {
    for (const name of names) {
      const hit = headers.indexOf(name);
      if (hit >= 0) return hit;
    }
    return -1;
  };

  if (format === 'bitwarden') {
    const title = pick(row, idx('name'));
    const username = pick(row, idx('login_username'));
    const password = pick(row, idx('login_password'));
    const url = pick(row, idx('login_uri'));
    const notes = pick(row, idx('notes'));
    const type = pick(row, idx('type')).toLowerCase();
    if (!title && !username && !password) return null;
    const item = baseItem(title, username, password, splitUrls(url), notes);
    if (type === 'note') item.kind = 'secureNote';
    item.totpSecret = totpSecretOf(pick(row, idx('login_totp')));
    const fav = pick(row, idx('favorite')).toLowerCase();
    item.favorite = fav === '1' || fav === 'true';
    return item;
  }

  if (format === 'chrome') {
    const title = pick(row, idx('name', 'title'));
    const username = pick(row, idx('username'));
    const password = pick(row, idx('password'));
    const url = pick(row, idx('url', 'urls', 'login_uri'));
    const notes = pick(row, idx('note', 'notes'));
    if (!title && !username && !password) return null;
    return baseItem(title, username, password, splitUrls(url), notes);
  }

  if (format === 'onePassword') {
    const title = pick(row, idx('title', 'name'));
    const username = pick(row, idx('username'));
    const password = pick(row, idx('password'));
    const url = pick(row, idx('url', 'urls'));
    const notes = pick(row, idx('notes'));
    if (!title && !username && !password) return null;
    const item = baseItem(title, username, password, splitUrls(url), notes);
    item.totpSecret = totpSecretOf(pick(row, idx('otpauth', 'one-time_password', 'totp')));
    const fav = pick(row, idx('favorite')).toLowerCase();
    item.favorite = fav === '1' || fav === 'true';
    const tags = pick(row, idx('tags'));
    item.tags = tags
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
    return item;
  }

  // keepass
  const title = pick(row, idx('title', 'account', 'name'));
  const username = pick(row, idx('username', 'login_name', 'user_name'));
  const password = pick(row, idx('password'));
  const url = pick(row, idx('url', 'urls'));
  const notes = pick(row, idx('notes', 'comment'));
  if (!title && !username && !password) return null;
  return baseItem(title, username, password, splitUrls(url), notes);
}

export function parseImport(text: string): ParsedImport {
  const trimmed = text.trim();
  if (!trimmed) return { format: 'unknown', items: [], skipped: 0 };

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed) as unknown;
    const rawItems = Array.isArray(data)
      ? data
      : Array.isArray((data as { items?: unknown }).items)
        ? ((data as { items: unknown[] }).items)
        : [];
    const items = rawItems
      .filter((x): x is VaultItem => !!x && typeof x === 'object' && 'title' in (x as object))
      .map((x) => ({ ...blankItem((x as VaultItem).kind ?? 'login'), ...(x as VaultItem), id: '', history: [] }));
    return { format: 'json', items, skipped: rawItems.length - items.length };
  }

  const rows = parseCsv(trimmed);
  if (rows.length < 2) return { format: 'unknown', items: [], skipped: 0 };
  const headers = rows[0].map(normalizeHeader);
  const has = (name: string) => headers.includes(name);

  let format = 'generic';
  if (has('login_username') || has('login_password')) format = 'bitwarden';
  else if (has('otpauth') && (has('title') || has('name'))) format = 'onePassword';
  else if (has('name') && has('url') && has('username') && has('password')) format = 'chrome';
  else if (has('title') || has('group') || has('account')) format = 'keepass';

  const items: VaultItem[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const item = mapRow(headers, row, format);
    if (item) items.push(item);
    else skipped++;
  }
  return { format, items, skipped };
}

export function toBitwardenCsv(items: VaultItem[]): string {
  const headers = [
    'folder',
    'favorite',
    'type',
    'name',
    'notes',
    'fields',
    'reprompt',
    'login_uri',
    'login_username',
    'login_password',
    'login_totp',
  ];
  const rows = items.map((i) => [
    i.tags[0] ?? '',
    i.favorite ? '1' : '0',
    i.kind === 'secureNote' ? 'note' : 'login',
    i.title,
    i.notes,
    '',
    '0',
    i.urls[0] ?? '',
    i.username,
    i.password,
    i.totpSecret ? `otpauth://totp/${encodeURIComponent(i.title)}?secret=${i.totpSecret}` : '',
  ]);
  return toCsv(headers, rows);
}

export function toChromeCsv(items: VaultItem[]): string {
  const headers = ['name', 'url', 'username', 'password', 'note'];
  return toCsv(
    headers,
    items.map((i) => [i.title, i.urls[0] ?? '', i.username, i.password, i.notes]),
  );
}
