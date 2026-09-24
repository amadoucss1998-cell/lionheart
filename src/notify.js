// Staff alerts for new orders and sourcing requests, by email (SMTP) and
// WhatsApp. Credentials come from environment variables; who receives the
// alerts is set by admins under Settings. Every attempt is logged so admins
// can see when an alert failed.
const nodemailer = require('nodemailer');
const { db, getSettings } = require('./db');
const { money, shippingLabel, MODES } = require('./helpers');

const env = process.env;
const TIMEOUT_MS = 15000;

// ---------- configuration ----------

let transport;
function mailer() {
  if (transport !== undefined) return transport;
  transport = env.SMTP_HOST
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT) || 587,
        secure: env.SMTP_SECURE === 'true' || Number(env.SMTP_PORT) === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS,
      })
    : null;
  return transport;
}

function whatsappProvider() {
  const p = (env.WHATSAPP_PROVIDER || '').toLowerCase();
  if (p === 'cloud' && env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) return 'cloud';
  if (p === 'twilio' && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM) return 'twilio';
  if (p === 'callmebot' && env.CALLMEBOT_RECIPIENTS) return 'callmebot';
  return null;
}

const splitList = (v) => String(v || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
const digits = (v) => String(v || '').replace(/\D/g, '');

function status() {
  const settings = getSettings();
  const provider = whatsappProvider();
  return {
    emailConfigured: Boolean(mailer()),
    emailRecipients: splitList(settings.alert_emails),
    whatsappProvider: provider,
    whatsappRequested: env.WHATSAPP_PROVIDER || '',
    whatsappRecipients: provider === 'callmebot' ? callmebotRecipients().map((r) => r.phone) : splitList(settings.alert_whatsapp_numbers).map(digits),
  };
}

function callmebotRecipients() {
  // CALLMEBOT_RECIPIENTS="231888979704:123456,971500000000:654321" (phone:apikey)
  return splitList(env.CALLMEBOT_RECIPIENTS)
    .map((pair) => {
      const [phone, apikey] = pair.split(':').map((x) => x.trim());
      return { phone: digits(phone), apikey };
    })
    .filter((r) => r.phone && r.apikey);
}

// ---------- logging ----------

function log(channel, recipient, subject, ok, error) {
  db.prepare('INSERT INTO notification_log (channel, recipient, subject, status, error) VALUES (?, ?, ?, ?, ?)').run(
    channel,
    recipient,
    subject,
    ok ? 'sent' : 'failed',
    error ? String(error).slice(0, 500) : null
  );
  db.prepare('DELETE FROM notification_log WHERE id NOT IN (SELECT id FROM notification_log ORDER BY id DESC LIMIT 500)').run();
  if (!ok) console.error(`[alerts] ${channel} to ${recipient} failed: ${error}`);
}

function recentLog(limit = 25) {
  return db.prepare('SELECT * FROM notification_log ORDER BY id DESC LIMIT ?').all(limit);
}

// ---------- senders ----------

async function sendEmail({ subject, text, html }) {
  const t = mailer();
  if (!t) return;
  const to = splitList(getSettings().alert_emails);
  if (!to.length) return;
  const from = env.MAIL_FROM || env.SMTP_USER || to[0];
  try {
    await t.sendMail({ from, to: to.join(', '), subject, text, html });
    log('email', to.join(', '), subject, true);
  } catch (err) {
    log('email', to.join(', '), subject, false, err.message);
  }
}

async function post(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  return body;
}

// WhatsApp template parameters may not contain newlines, tabs or 4+ spaces.
const templateSafe = (s) => String(s).replace(/[\r\n\t]+/g, ' · ').replace(/ {4,}/g, '   ').slice(0, 1000);

const sendersByProvider = {
  async cloud(to, msg) {
    const url = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION || 'v21.0'}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    // Messages a business starts must use an approved template (see README).
    // Without WHATSAPP_TEMPLATE a plain text message is sent, which WhatsApp only
    // delivers if that number messaged your business in the last 24 hours.
    const payload = env.WHATSAPP_TEMPLATE
      ? {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: env.WHATSAPP_TEMPLATE,
            language: { code: env.WHATSAPP_TEMPLATE_LANG || 'en' },
            components: [{ type: 'body', parameters: msg.params.map((p) => ({ type: 'text', text: templateSafe(p) })) }],
          },
        }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body: msg.text, preview_url: true } };
    await post(url, { method: 'POST', headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  },

  async twilio(to, msg) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
    const form = new URLSearchParams({ From: `whatsapp:+${digits(env.TWILIO_WHATSAPP_FROM)}`, To: `whatsapp:+${to}` });
    if (env.TWILIO_CONTENT_SID) {
      form.set('ContentSid', env.TWILIO_CONTENT_SID);
      form.set('ContentVariables', JSON.stringify(Object.fromEntries(msg.params.map((p, i) => [String(i + 1), templateSafe(p)]))));
    } else form.set('Body', msg.text);
    const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
    await post(url, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  },

  async callmebot(to, msg, apikey) {
    const url = `https://api.callmebot.com/whatsapp.php?${new URLSearchParams({ phone: to, text: msg.text, apikey })}`;
    const body = await post(url, { method: 'GET' });
    if (/error|invalid|not allowed/i.test(body) && !/queued|sent/i.test(body)) throw new Error(body.replace(/<[^>]+>/g, ' ').trim().slice(0, 300));
  },
};

async function sendWhatsApp(msg) {
  const provider = whatsappProvider();
  if (!provider) return;
  const recipients =
    provider === 'callmebot'
      ? callmebotRecipients()
      : splitList(getSettings().alert_whatsapp_numbers).map((n) => ({ phone: digits(n) })).filter((r) => r.phone);
  await Promise.all(
    recipients.map(async (r) => {
      try {
        await sendersByProvider[provider](r.phone, msg, r.apikey);
        log(`whatsapp:${provider}`, `+${r.phone}`, msg.subject, true);
      } catch (err) {
        log(`whatsapp:${provider}`, `+${r.phone}`, msg.subject, false, err.message);
      }
    })
  );
}

// ---------- messages ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function baseUrl(fallback) {
  return (env.PUBLIC_URL || fallback || '').replace(/\/+$/, '');
}

function emailShell(title, intro, rowsHtml, link, linkLabel) {
  return `<!doctype html><html><body style="margin:0;background:#f6f8fb;font-family:Arial,Helvetica,sans-serif;color:#1b2430">
  <div style="max-width:640px;margin:0 auto;padding:24px">
    <div style="background:#17324f;color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
      <div style="color:#c9a227;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:bold">Lionheart alert</div>
      <div style="font-size:20px;font-weight:bold;margin-top:4px">${esc(title)}</div>
    </div>
    <div style="background:#fff;border:1px solid #e2e7ee;border-top:0;padding:22px;border-radius:0 0 10px 10px">
      <p style="margin:0 0 16px">${intro}</p>
      ${rowsHtml}
      ${link ? `<p style="margin:22px 0 0"><a href="${esc(link)}" style="background:#c9a227;color:#0f2238;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px;display:inline-block">${esc(linkLabel)}</a></p>` : ''}
    </div>
  </div></body></html>`;
}

const kvTable = (rows) =>
  `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#5d6b7a;width:130px;vertical-align:top">${esc(k)}</td><td style="padding:6px 0">${esc(v)}</td></tr>`)
    .join('')}</table>`;

function orderMessages(order, items, fallbackUrl) {
  const currency = getSettings().currency || 'USD';
  const fmt = (v) => money(v, currency);
  const link = baseUrl(fallbackUrl) ? `${baseUrl(fallbackUrl)}/admin/orders/${order.ref}` : '';
  const destination = [order.city, order.country].filter(Boolean).join(', ');
  const estimate = order.estimate_total ? fmt(order.estimate_total) : 'Price on request';
  const itemLine = (i) => `${i.qty} ${i.unit || ''} × ${i.product_name} (${i.mode === 'source' ? 'China sourcing' : 'from stock'})`.replace(/\s+/g, ' ');
  const shown = items.slice(0, 10).map(itemLine);
  if (items.length > 10) shown.push(`…and ${items.length - 10} more`);
  const customer = `${order.customer_name}${order.company ? ` (${order.company})` : ''}`;
  const subject = `New order ${order.ref}: ${order.customer_name}, ${order.country || '—'} (${estimate})`;

  const text = [
    `🦁 NEW ORDER ${order.ref}`,
    `Customer: ${customer}`,
    `Phone: ${order.phone || '—'}`,
    `Email: ${order.email}`,
    `Destination: ${destination || '—'}`,
    `Shipping: ${shippingLabel(order.shipping_method)}`,
    '',
    'Items:',
    ...shown.map((l) => `• ${l}`),
    '',
    `Estimated goods value: ${estimate}`,
    order.notes ? `Notes: ${order.notes.slice(0, 300)}` : '',
    link ? `\nOpen: ${link}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');

  const itemsHtml = `<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:14px">
    <tr><th style="text-align:left;padding:8px;background:#f6f8fb;border-bottom:1px solid #e2e7ee">Product</th><th style="text-align:left;padding:8px;background:#f6f8fb;border-bottom:1px solid #e2e7ee">Option</th><th style="text-align:right;padding:8px;background:#f6f8fb;border-bottom:1px solid #e2e7ee">Qty</th><th style="text-align:right;padding:8px;background:#f6f8fb;border-bottom:1px solid #e2e7ee">Unit price</th></tr>
    ${items
      .map(
        (i) => `<tr><td style="padding:8px;border-bottom:1px solid #e2e7ee"><strong>${esc(i.product_name)}</strong>${i.notes ? `<br><span style="color:#5d6b7a">Note: ${esc(i.notes)}</span>` : ''}</td>
        <td style="padding:8px;border-bottom:1px solid #e2e7ee">${esc(MODES[i.mode].short)}</td>
        <td style="padding:8px;border-bottom:1px solid #e2e7ee;text-align:right">${esc(i.qty)} ${esc(i.unit || '')}</td>
        <td style="padding:8px;border-bottom:1px solid #e2e7ee;text-align:right">${i.unit_price !== null ? esc(fmt(i.unit_price)) : 'On request'}</td></tr>`
      )
      .join('')}
  </table>
  <p style="text-align:right;font-size:16px;margin:12px 0 0">Estimated goods value: <strong>${esc(estimate)}</strong></p>`;

  const html = emailShell(
    `New order ${order.ref}`,
    `<strong>${esc(customer)}</strong> placed an order that needs a quotation.`,
    kvTable([
      ['Phone', order.phone],
      ['Email', order.email],
      ['Destination', destination],
      ['Address', order.delivery_address],
      ['Shipping', shippingLabel(order.shipping_method)],
      ['Notes', order.notes],
    ]) + itemsHtml,
    link,
    'Open order & send quotation'
  );

  // Template variables {{1}}..{{6}} for WhatsApp Cloud API / Twilio templates.
  const params = [order.ref, customer, `${destination || '—'} (${order.phone || order.email})`, shown.join('; '), estimate, link || order.ref];
  return { subject, text, html, params };
}

function requestMessages(request, fallbackUrl) {
  const link = baseUrl(fallbackUrl) ? `${baseUrl(fallbackUrl)}/admin/requests/${request.ref}` : '';
  const subject = `New sourcing request ${request.ref}: ${request.name}${request.country ? `, ${request.country}` : ''}`;
  const text = [
    `🦁 NEW SOURCING REQUEST ${request.ref}`,
    `From: ${request.name}`,
    `Phone: ${request.phone || '—'}`,
    `Email: ${request.email}`,
    request.country ? `Country: ${request.country}` : '',
    '',
    `Needs: ${request.description.slice(0, 500)}`,
    request.quantity ? `Quantity: ${request.quantity}` : '',
    request.target_price ? `Target price: ${request.target_price}` : '',
    link ? `\nOpen: ${link}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
  const html = emailShell(
    `New sourcing request ${request.ref}`,
    `<strong>${esc(request.name)}</strong> is looking for a product we don't list yet.`,
    kvTable([
      ['Needs', request.description],
      ['Quantity', request.quantity],
      ['Target price', request.target_price],
      ['Phone', request.phone],
      ['Email', request.email],
      ['Country', request.country],
      ['Photo', request.image_filename ? 'Attached in the admin panel' : ''],
    ]),
    link,
    'Open request'
  );
  const params = [request.ref, request.name, `${request.country || '—'} (${request.phone || request.email})`, request.description.slice(0, 300), request.quantity || '—', link || request.ref];
  return { subject, text, html, params };
}

// ---------- public API ----------

// Alerts never block or break the customer's request: they run in the
// background and failures only end up in the log.
function dispatch(msg) {
  return Promise.allSettled([sendEmail(msg), sendWhatsApp(msg)]).then(() => undefined);
}

function notifyNewOrder(orderId, fallbackUrl) {
  return safely(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
    return dispatch(orderMessages(order, items, fallbackUrl));
  });
}

function notifyNewRequest(requestId, fallbackUrl) {
  return safely(() => {
    if (getSettings().alert_on_requests === 'no') return undefined;
    const request = db.prepare('SELECT * FROM sourcing_requests WHERE id = ?').get(requestId);
    return dispatch(requestMessages(request, fallbackUrl));
  });
}

function sendTest(fallbackUrl) {
  const link = baseUrl(fallbackUrl) ? `${baseUrl(fallbackUrl)}/admin` : '';
  const text = `🦁 Lionheart test alert\nIf you can read this, new order alerts will reach you here.${link ? `\n${link}` : ''}`;
  return dispatch({
    subject: 'Lionheart test alert',
    text,
    html: emailShell('Test alert', 'If you can read this, new order alerts will reach this inbox.', '', link, 'Open admin'),
    params: ['TEST', 'Lionheart test alert', 'Alerts are working', 'No items', '—', link || 'TEST'],
  });
}

function safely(fn) {
  return Promise.resolve()
    .then(fn)
    .catch((err) => console.error('[alerts] unexpected error', err));
}

module.exports = {
  notifyNewOrder,
  notifyNewRequest,
  sendTest,
  status,
  recentLog,
  orderMessages,
  _setTransport: (t) => { transport = t; },
};
