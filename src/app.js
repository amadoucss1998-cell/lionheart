const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const compression = require('compression');
const { locals, csrfGlobal, UPLOAD_DIR } = require('./middleware');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  let secret = process.env.SESSION_SECRET;
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    if (process.env.NODE_ENV === 'production') {
      console.warn('WARNING: SESSION_SECRET is not set. Sessions will reset on every restart.');
    }
  }

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    next();
  });
  app.use(compression());
  // Front-end libraries are served from node_modules so the site needs no external CDN.
  const vendor = (dir) => express.static(path.join(__dirname, '..', 'node_modules', dir), { maxAge: '7d' });
  app.use('/vendor/three', vendor('three/build'));
  app.use('/vendor/gsap', vendor('gsap/dist'));
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', fallthrough: false }));
  app.use(express.urlencoded({ extended: false, limit: '1mb', parameterLimit: 5000 }));
  app.use(
    cookieSession({
      name: 'lh_session',
      keys: [secret],
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
    })
  );
  app.use(locals);
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
