const crypto = require('crypto');

const ORDER_STATUSES = [
  { key: 'received', label: 'Order received', customer: 'We have received your order and are checking prices, availability and shipping with our suppliers.' },
  { key: 'quoted', label: 'Quotation sent', customer: 'Your quotation is ready. Please review and accept it to continue.' },
  { key: 'accepted', label: 'Quote accepted', customer: 'You accepted the quotation. We will send you the invoice and payment details.' },
  { key: 'paid', label: 'Payment confirmed', customer: 'We have confirmed your payment.' },
  { key: 'purchasing', label: 'Purchasing from supplier', customer: 'We are buying your goods from the factory or supplier.' },
  { key: 'inspection', label: 'Quality inspection', customer: 'Your goods are being checked at our warehouse before loading.' },
  { key: 'shipped', label: 'Shipped', customer: 'Your goods have left the warehouse and are on their way.' },
  { key: 'arrived', label: 'Arrived / customs clearing', customer: 'Your goods have arrived at the destination port and are being cleared.' },
  { key: 'delivered', label: 'Delivered', customer: 'Your order has been delivered. Thank you for choosing Lionheart!' },
  { key: 'cancelled', label: 'Cancelled', customer: 'This order has been cancelled.' },
];
const STATUS_KEYS = ORDER_STATUSES.map((s) => s.key);
const statusLabel = (key) => (ORDER_STATUSES.find((s) => s.key === key) || { label: key }).label;

const SOURCING_STATUSES = [
  { key: 'new', label: 'New' },
  { key: 'searching', label: 'Searching suppliers' },
  { key: 'quoted', label: 'Quote sent' },
  { key: 'converted', label: 'Converted to order' },
  { key: 'closed', label: 'Closed' },
];

const SHIPPING_METHODS = [
  { key: 'sea_fcl', label: 'Sea freight – full container (FCL)' },
  { key: 'sea_lcl', label: 'Sea freight – shared container (LCL)' },
  { key: 'air', label: 'Air freight' },
  { key: 'roro', label: 'RoRo (vehicles & heavy machinery)' },
  { key: 'pickup_dubai', label: 'Pick up at our Dubai warehouse' },
  { key: 'pickup_china', label: 'Pick up at our China warehouse' },
  { key: 'advise', label: 'Not sure – please advise me' },
];
const shippingLabel = (key) => (SHIPPING_METHODS.find((s) => s.key === key) || { label: key || '—' }).label;

const MODES = {
  source: { label: 'Source from China', short: 'China sourcing' },
  stock: { label: 'Buy from Lionheart stock', short: 'From our stock' },
};

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

async function uniqueSlug(db, table, base, ignoreId) {
  if (!['products', 'categories'].includes(table)) throw new Error('bad table');
  const root = slugify(base);
  let slug = root;
  for (let n = 2; ; n++) {
    const row = await db.get(`SELECT id FROM ${table} WHERE slug = ?`, [slug]);
    if (!row || row.id === ignoreId) return slug;
    slug = `${root}-${n}`;
  }
}

// Formats a database timestamp (Date or ISO string) for display.
function formatDate(v, style = 'datetime') {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  const opts = style === 'date' ? { dateStyle: 'medium' } : style === 'short' ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' };
  return d.toLocaleString('en-GB', { ...opts, timeZone: 'UTC' }) + (style === 'date' ? '' : ' UTC');
}

function makeRef(prefix) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${prefix}-${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function money(v, currency = 'USD') {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(v));
  } catch {
    return `${currency} ${Number(v).toFixed(2)}`;
  }
}

// Parse a specs textarea ("Key: Value" per line) into pairs.
function parseSpecs(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(':');
      return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : ['', l];
    });
}

function toNumberOrNull(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(v) {
  const n = toNumberOrNull(v);
  return n === null ? null : Math.round(n);
}

// Minimal RFC 4180 CSV parser (handles quotes, escaped quotes and newlines in quotes).
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] || '').trim()])));
}

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = {
  ORDER_STATUSES,
  STATUS_KEYS,
  statusLabel,
  SOURCING_STATUSES,
  SHIPPING_METHODS,
  shippingLabel,
  MODES,
  slugify,
  uniqueSlug,
  formatDate,
  makeRef,
  money,
  parseSpecs,
  toNumberOrNull,
  toIntOrNull,
  parseCSV,
  csvEscape,
};
