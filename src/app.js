const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const compression = require('compression');
const { locals, csrfGlobal } = require('./middleware');
const { rateLimit } = require('./rate-limit');
const { db } = require('./db');
const { bootstrap } = require('./seed');
const storage = require('./storage');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Secure cookies and HSTS are switched on when the public address is HTTPS.
  // COOKIE_SECURE=true/false overrides the automatic choice.
  // On Vercel the site is always served over HTTPS.
  const https = Boolean(process.env.VERCEL) || /^https:\/\//i.test(process.env.PUBLIC_URL || '');
  const secureCookies = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : https;

  let secret = process.env.SESSION_SECRET;
  if (!secret && process.env.VERCEL) {
    // Every serverless instance would otherwise invent its own secret and
    // visitors would be signed out / get "session expired" at random.
    throw new Error('SESSION_SECRET is not set. Add it in Vercel → Project → Settings → Environment Variables.');
  }
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    if (process.env.NODE_ENV === 'production') {
      console.warn('WARNING: SESSION_SECRET is not set. Sessions will reset on every restart.');
    }
  }

  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    `img-src 'self' data: blob:${storage.storageOrigin ? ` ${storage.storageOrigin}` : ''}`,
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (https) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // Health check for load balancers, Docker and uptime monitors.
  app.get('/healthz', async (req, res) => {
    try {
      await bootstrap();
      await db.get('SELECT 1 AS ok');
      res.set('Cache-Control', 'no-store').json({ ok: true, database: db.kind, storage: storage.useSupabase ? 'supabase' : 'local' });
    } catch (err) {
      console.error('[healthz]', err.message);
      res.status(503).set('Cache-Control', 'no-store').json({ ok: false });
    }
  });
  app.use(compression());
  // Front-end libraries are served from node_modules so the site needs no external CDN.
  const vendor = (dir) => express.static(path.join(__dirname, '..', 'node_modules', dir), { maxAge: '7d' });
  app.use('/vendor/three', vendor('three/build'));
  app.use('/vendor/gsap', vendor('gsap/dist'));
  // public/ is served as-is (on Vercel its CDN serves these files directly).
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d', index: false }));
  if (!storage.useSupabase) app.use('/uploads', express.static(storage.UPLOAD_DIR, { maxAge: '30d', fallthrough: false }));

  // Make sure tables, the admin account and settings exist before handling
  // requests (runs once per process / serverless instance).
  app.use(async (req, res, next) => {
    await bootstrap();
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: '1mb', parameterLimit: 5000 }));
  app.use(
    cookieSession({
      name: 'lh_session',
      keys: [secret],
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
    })
  );
  app.use(locals);

  // Slow down password guessing, order-number guessing and form spam.
  const MIN = 60 * 1000;
  app.post('/login', rateLimit({ windowMs: 15 * MIN, max: 10, message: 'Too many sign-in attempts. Please wait 15 minutes and try again.' }));
  app.post('/register', rateLimit({ windowMs: 60 * MIN, max: 10 }));
  app.post('/track', rateLimit({ windowMs: 15 * MIN, max: 20 }));
  app.post('/checkout', rateLimit({ windowMs: 60 * MIN, max: 20 }));
  app.post('/request', rateLimit({ windowMs: 60 * MIN, max: 15 }));

  app.use(csrfGlobal);

  app.use('/', require('./routes/shop'));
  app.use('/', require('./routes/account'));
  app.use('/admin', require('./routes/admin'));

  app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'The page you are looking for does not exist.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).render('error', { title: 'File too large', message: 'Images must be smaller than 8 MB each.' });
    }
    if (err.status === 404 && req.path.startsWith('/uploads/')) return res.status(404).end();
    console.error(err);
    res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
  });

  return app;
}

module.exports = { createApp };
