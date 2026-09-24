const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db, getSettings, DATA_DIR } = require('./db');
const helpers = require('./helpers');
const { icon } = require('./icons');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${IMAGE_TYPES[file.mimetype]}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, cb) => cb(null, Boolean(IMAGE_TYPES[file.mimetype])),
});

// CSV imports are kept in memory; they are parsed and discarded.
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

function locals(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  const user = req.session.userId
    ? db.prepare('SELECT id, name, email, phone, company, country, role FROM users WHERE id = ?').get(req.session.userId)
    : null;
  if (req.session.userId && !user) req.session.userId = null;
  req.user = user;
  const settings = getSettings();
  req.settings = settings;
  res.locals.user = user;
  res.locals.settings = settings;
  res.locals.csrf = req.session.csrf;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  res.locals.cartCount = (req.session.cart || []).length;
  res.locals.path = req.path;
  res.locals.h = helpers;
  res.locals.icon = icon;
  res.locals.fmt = (v) => helpers.money(v, settings.currency || 'USD');
  res.locals.categoriesNav = db.prepare('SELECT id, name, slug, icon FROM categories ORDER BY sort_order, name').all();
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

function uploadedFiles(req) {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  return Object.values(req.files || {}).flat();
}

// Runs multer, then the CSRF check; files from a rejected request are deleted.
const withUpload = (mw) => [
  mw,
  (req, res, next) => {
    if (req.body && req.body._csrf && req.body._csrf === req.session.csrf) return next();
    uploadedFiles(req).forEach((f) => f.filename && removeUpload(f.filename));
    csrfCheck(req, res, next);
  },
];

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

function removeUpload(filename) {
  if (!filename) return;
  const file = path.join(UPLOAD_DIR, path.basename(filename));
  fs.promises.unlink(file).catch(() => {});
}

module.exports = { upload, csvUpload, locals, flash, csrfCheck, csrfGlobal, withUpload, requireLogin, requireStaff, requireAdmin, safeNext, removeUpload, UPLOAD_DIR };
