const crypto = require('crypto');
const multer = require('multer');
const { db, getSettings } = require('./db');
const helpers = require('./helpers');
const { icon } = require('./icons');
const storage = require('./storage');

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Uploads are held in memory, then saved by storage.js (Supabase Storage or
// local disk) only after the request has passed validation and CSRF checks.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, cb) => cb(null, IMAGE_TYPES.includes(file.mimetype)),
});

// CSV imports are kept in memory; they are parsed and discarded.
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

async function locals(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  const [user, settings, categoriesNav] = await Promise.all([
    req.session.userId ? db.get('SELECT id, name, email, phone, company, country, role FROM users WHERE id = ?', [req.session.userId]) : null,
    getSettings(),
    db.all(
      `SELECT id, name, slug, icon, EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id AND p.active = 1) AS has_products
       FROM categories c ORDER BY sort_order, name`
    ),
  ]);
  if (req.session.userId && !user) req.session.userId = null;
  req.user = user || null;
  req.settings = settings;
  res.locals.user = req.user;
  res.locals.settings = settings;
  res.locals.csrf = req.session.csrf;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  res.locals.cartCount = (req.session.cart || []).length;
  res.locals.path = req.path;
  res.locals.h = helpers;
  res.locals.icon = icon;
  res.locals.img = storage.imageUrl;
  res.locals.fmt = (v) => helpers.money(v, settings.currency || 'USD');
  // Public menus only list categories that have products; forms use them all.
  res.locals.categoriesAll = categoriesNav;
  res.locals.categoriesNav = categoriesNav.filter((c) => c.has_products);
  next();
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

// Double-submit style check: the token lives in the signed session cookie
// and must be echoed in every state-changing request.
function csrfCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (!token || token !== req.session.csrf) {
    return res.status(403).render('error', { title: 'Session expired', message: 'Your form session expired. Please go back, refresh the page and try again.' });
  }
  next();
}

// Multipart bodies are not parsed until multer runs inside the route, so the
// global check defers to the route. Upload routes must use withUpload().
function csrfGlobal(req, res, next) {
  if (req.is('multipart/form-data')) return next();
  csrfCheck(req, res, next);
}

// Multer parses the body, then the CSRF token is checked. Nothing has been
// stored yet at that point, so a rejected request leaves no files behind.
const withUpload = (mw) => [mw, csrfCheck];

function requireLogin(req, res, next) {
  if (req.user) return next();
  flash(req, 'info', 'Please sign in to continue.');
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function requireStaff(req, res, next) {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'staff')) return next();
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  res.status(403).render('error', { title: 'Access denied', message: 'You do not have access to this page.' });
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).render('error', { title: 'Access denied', message: 'Only administrators can do this.' });
}

// Only allow relative redirects to avoid open-redirect abuse via ?next=
function safeNext(next, fallback = '/') {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : fallback;
}

module.exports = { upload, csvUpload, locals, flash, csrfCheck, csrfGlobal, withUpload, requireLogin, requireStaff, requireAdmin, safeNext };
