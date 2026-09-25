// Site languages. English is written in the templates; French is applied to the
// finished HTML of customer pages by swapping whole phrases (text between tags
// and user-facing attributes) using the dictionary in i18n-fr.js. Anything the
// dictionary does not know (product names, customer data) stays as written.
const FR = require('./i18n-fr');

const LANGS = ['en', 'fr'];
const DEFAULT_LANG = 'en';

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#34;': '"', '&#39;': "'", '&nbsp;': ' ' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#34|#39|nbsp);/g, (m) => ENTITIES[m]);
const encode = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/ /g, '&nbsp;');

// Phrases with values in them, written as "Order {ref}", become regular expressions.
function compile(dict) {
  const exact = new Map();
  const patterns = [];
  for (const [en, fr] of Object.entries(dict)) {
    if (!/\{#?\w+\}/.test(en)) {
      exact.set(en, fr);
      continue;
    }
    const names = [];
    const source = en
      .split(/(\{#?\w+\})/)
      .map((part) => {
        const m = /^\{(#?)(\w+)\}$/.exec(part);
        if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        names.push(m[2]);
        return m[1] ? '(\\d[\\d.,]*)' : '(.+?)';
      })
      .join('');
    patterns.push({ re: new RegExp(`^${source}$`), names, fr });
  }
  return { exact, patterns };
}

const COMPILED = { fr: compile(FR) };

// Translates one plain-text phrase; returns it unchanged when unknown.
function translate(text, lang) {
  const table = COMPILED[lang];
  if (!table) return text;
  const hit = table.exact.get(text);
  if (hit !== undefined) return hit;
  for (const { re, names, fr } of table.patterns) {
    const m = re.exec(text);
    if (m) return fr.replace(/\{#?(\w+)\}/g, (_, name) => {
      const i = names.indexOf(name);
      return i === -1 ? '' : translate(m[i + 1], lang);
    });
  }
  return text;
}

// Translates a piece of escaped HTML text, keeping its surrounding whitespace.
function translateEscaped(raw, lang) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
  if (!m[2] || !/[A-Za-z]/.test(m[2])) return raw;
  const text = decode(m[2]).replace(/\s+/g, ' ');
  const out = translate(text, lang);
  return out === text ? raw : m[1] + encode(out) + m[3];
}

const ATTRS = /\s(placeholder|title|aria-label|alt|data-confirm|content)="([^"]*)"/g;

function translateHtml(html, lang) {
  if (!COMPILED[lang]) return html;
  // Scripts and styles are left exactly as they are.
  return html
    .split(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)/i)
    .map((chunk, i) => {
      if (i % 2) return chunk;
      return chunk
        .replace(/>([^<]+)</g, (all, text) => `>${translateEscaped(text, lang)}<`)
        .replace(/(<[^>]+>)/g, (tag) => tag.replace(ATTRS, (all, name, value) => ` ${name}="${translateEscaped(value, lang)}"`));
    })
    .join('')
    .replace(/<html lang="en">/, `<html lang="${lang}">`);
}

// Picks the language: ?lang= (remembered), then the visitor's saved choice,
// then the browser's preferred language.
function pickLang(req) {
  const q = String(req.query.lang || '');
  if (LANGS.includes(q)) {
    req.session.lang = q;
    return q;
  }
  if (LANGS.includes(req.session.lang)) return req.session.lang;
  const accept = String(req.get('accept-language') || '').toLowerCase();
  return /^fr\b/.test(accept) ? 'fr' : DEFAULT_LANG;
}

// Middleware: sets res.locals.lang / t and translates rendered customer pages.
function i18n(req, res, next) {
  const lang = pickLang(req);
  res.locals.lang = lang;
  res.locals.t = (text) => translate(text, lang);
  // Same page in another language (GET pages keep their query string).
  res.locals.langUrl = (code) => {
    const url = new URL(req.method === 'GET' ? req.originalUrl : req.path, 'http://x');
    url.searchParams.set('lang', code);
    return url.pathname + url.search;
  };
  res.vary('Accept-Language');
  if (lang === 'fr' && res.locals.h) {
    const h = res.locals.h;
    res.locals.h = { ...h, formatDate: (v, style) => h.formatDate(v, style, 'fr-FR') };
  }
  if (lang !== DEFAULT_LANG && !req.path.startsWith('/admin')) {
    const render = res.render.bind(res);
    res.render = (view, options, callback) => {
      if (typeof options === 'function' || callback) return render(view, options, callback);
      render(view, options, (err, html) => {
        if (err) return next(err);
        res.send(translateHtml(html, lang));
      });
    };
  }
  next();
}

module.exports = { i18n, translate, translateHtml, LANGS };
