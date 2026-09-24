const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { flash, requireLogin, safeNext } = require('../middleware');

const router = express.Router();
const trim = (v, max = 200) => String(v || '').trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Attach orders placed as a guest in this browser (same email) to the account.
function claimGuestOrders(req, user) {
  const refs = req.session.guestOrders || [];
  if (!refs.length) return;
  const stmt = db.prepare('UPDATE orders SET user_id = ? WHERE ref = ? AND user_id IS NULL AND lower(email) = lower(?)');
  refs.forEach((ref) => stmt.run(user.id, ref, user.email));
}

function signIn(req, user) {
  req.session.userId = user.id;
  claimGuestOrders(req, user);
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next, '/account'));
  res.render('login', { title: 'Sign in', next: safeNext(req.query.next, ''), email: '', error: null });
});

router.post('/login', (req, res) => {
  const email = trim(req.body.email, 160).toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).render('login', { title: 'Sign in', next: safeNext(req.body.next, ''), email, error: 'Incorrect email or password.' });
  }
  signIn(req, user);
  const fallback = user.role === 'customer' ? '/account' : '/admin';
  res.redirect(safeNext(req.body.next, fallback));
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/account');
  res.render('register', { title: 'Create account', next: safeNext(req.query.next, ''), form: {}, errors: [] });
});

router.post('/register', (req, res) => {
  const form = {
    name: trim(req.body.name, 120),
    email: trim(req.body.email, 160).toLowerCase(),
    phone: trim(req.body.phone, 40),
    company: trim(req.body.company, 120),
    country: trim(req.body.country, 80),
  };
  const password = String(req.body.password || '');
  const errors = [];
  if (!form.name) errors.push('Please enter your name.');
  if (!EMAIL_RE.test(form.email)) errors.push('Please enter a valid email address.');
  if (password.length < 8) errors.push('Password must be at least 8 characters.');
  if (password !== String(req.body.password2 || '')) errors.push('Passwords do not match.');
  if (!errors.length && db.prepare('SELECT 1 FROM users WHERE email = ?').get(form.email)) {
    errors.push('An account with this email already exists. Please sign in.');
  }
  if (errors.length) return res.status(400).render('register', { title: 'Create account', next: safeNext(req.body.next, ''), form, errors });

  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (name, email, phone, company, country, password_hash) VALUES (@name, @email, @phone, @company, @country, @hash)')
    .run({ ...form, hash: bcrypt.hashSync(password, 10) });
  signIn(req, { id: lastInsertRowid, email: form.email });
  flash(req, 'success', `Welcome to Lionheart, ${form.name}!`);
  res.redirect(safeNext(req.body.next, '/account'));
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

router.get('/account', requireLogin, (req, res) => {
  const orders = db
    .prepare(
      `SELECT o.*, (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count
       FROM orders o WHERE user_id = ? ORDER BY created_at DESC, id DESC`
    )
    .all(req.user.id);
  const requests = db.prepare('SELECT * FROM sourcing_requests WHERE user_id = ? ORDER BY created_at DESC, id DESC').all(req.user.id);
  res.render('account/index', { title: 'My account', orders, requests });
});

router.get('/account/profile', requireLogin, (req, res) => {
  res.render('account/profile', { title: 'My profile', form: req.user, errors: [] });
});

router.post('/account/profile', requireLogin, (req, res) => {
  const form = {
    name: trim(req.body.name, 120),
    phone: trim(req.body.phone, 40),
    company: trim(req.body.company, 120),
    country: trim(req.body.country, 80),
  };
  const errors = [];
  if (!form.name) errors.push('Please enter your name.');
  const newPassword = String(req.body.new_password || '');
  if (newPassword) {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(String(req.body.current_password || ''), row.password_hash)) errors.push('Current password is incorrect.');
    if (newPassword.length < 8) errors.push('New password must be at least 8 characters.');
  }
  if (errors.length) return res.status(400).render('account/profile', { title: 'My profile', form: { ...req.user, ...form }, errors });

  db.prepare('UPDATE users SET name = @name, phone = @phone, company = @company, country = @country WHERE id = @id').run({ ...form, id: req.user.id });
  if (newPassword) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), req.user.id);
  flash(req, 'success', 'Profile saved.');
  res.redirect('/account/profile');
});

module.exports = router;
