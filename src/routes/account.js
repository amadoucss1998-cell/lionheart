const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { flash, requireLogin, safeNext } = require('../middleware');

const router = express.Router();
const trim = (v, max = 200) => String(v || '').trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Attach orders placed as a guest in this browser (same email) to the account.
async function claimGuestOrders(req, user) {
  const refs = req.session.guestOrders || [];
  if (!refs.length) return;
  await db.run(
    `UPDATE orders SET user_id = ? WHERE ref IN (${refs.map(() => '?').join(', ')}) AND user_id IS NULL AND lower(email) = lower(?)`,
    [user.id, ...refs, user.email]
  );
}

async function signIn(req, user) {
  req.session.userId = user.id;
  await claimGuestOrders(req, user);
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next, '/account'));
  res.render('login', { title: 'Sign in', next: safeNext(req.query.next, ''), email: '', error: null });
});

router.post('/login', async (req, res) => {
  const email = trim(req.body.email, 160).toLowerCase();
  const user = await db.get('SELECT * FROM users WHERE lower(email) = ?', [email]);
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
    return res.status(401).render('login', { title: 'Sign in', next: safeNext(req.body.next, ''), email, error: 'Incorrect email or password.' });
  }
  await signIn(req, user);
  const fallback = user.role === 'customer' ? '/account' : '/admin';
  res.redirect(safeNext(req.body.next, fallback));
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/account');
  res.render('register', { title: 'Create account', next: safeNext(req.query.next, ''), form: {}, errors: [] });
});

router.post('/register', async (req, res) => {
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
  if (!errors.length && (await db.get('SELECT 1 AS ok FROM users WHERE lower(email) = ?', [form.email]))) {
    errors.push('An account with this email already exists. Please sign in.');
  }
  if (errors.length) return res.status(400).render('register', { title: 'Create account', next: safeNext(req.body.next, ''), form, errors });

  const id = await db.insert(
    'INSERT INTO users (name, email, phone, company, country, password_hash) VALUES (@name, @email, @phone, @company, @country, @hash)',
    { ...form, hash: await bcrypt.hash(password, 10) }
  );
  await signIn(req, { id, email: form.email });
  flash(req, 'success', `Welcome to Lionheart, ${form.name}!`);
  res.redirect(safeNext(req.body.next, '/account'));
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

router.get('/account', requireLogin, async (req, res) => {
  const [orders, requests] = await Promise.all([
    db.all(
      `SELECT o.*, (SELECT COUNT(*)::int FROM order_items i WHERE i.order_id = o.id) AS item_count
       FROM orders o WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
      [req.user.id]
    ),
    db.all('SELECT * FROM sourcing_requests WHERE user_id = ? ORDER BY created_at DESC, id DESC', [req.user.id]),
  ]);
  res.render('account/index', { title: 'My account', orders, requests });
});

router.get('/account/profile', requireLogin, (req, res) => {
  res.render('account/profile', { title: 'My profile', form: req.user, errors: [] });
});

router.post('/account/profile', requireLogin, async (req, res) => {
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
    const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!(await bcrypt.compare(String(req.body.current_password || ''), row.password_hash))) errors.push('Current password is incorrect.');
    if (newPassword.length < 8) errors.push('New password must be at least 8 characters.');
  }
  if (errors.length) return res.status(400).render('account/profile', { title: 'My profile', form: { ...req.user, ...form }, errors });

  await db.run('UPDATE users SET name = @name, phone = @phone, company = @company, country = @country WHERE id = @id', { ...form, id: req.user.id });
  if (newPassword) await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(newPassword, 10), req.user.id]);
  flash(req, 'success', 'Profile saved.');
  res.redirect('/account/profile');
});

module.exports = router;
