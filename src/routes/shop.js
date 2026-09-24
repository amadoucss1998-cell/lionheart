const express = require('express');
const { db } = require('../db');
const { listProducts, getProduct, modeAvailable, hydrateCart } = require('../catalog');
const { upload, withUpload, flash } = require('../middleware');
const { SHIPPING_METHODS, makeRef, toIntOrNull, parseSpecs } = require('../helpers');
const { orderForViewer, loadOrderDetail } = require('../orders');

const router = express.Router();
const PAGE_SIZE = 24;
const MAX_CART_LINES = 40;

const trim = (v, max = 2000) => String(v || '').trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/', (req, res) => {
  const featured = listProducts({ featured: true, limit: 8 }).items;
  const latest = listProducts({ sort: 'newest', limit: 8 }).items;
  const counts = Object.fromEntries(
    db.prepare('SELECT category_id, COUNT(*) AS n FROM products WHERE active = 1 GROUP BY category_id').all().map((r) => [r.category_id, r.n])
  );
  const totals = {
    products: db.prepare('SELECT COUNT(*) AS n FROM products WHERE active = 1').get().n,
    categories: db.prepare('SELECT COUNT(*) AS n FROM categories').get().n,
  };
  res.render('home', { title: null, featured, latest, counts, totals, hero3d: true });
});

router.get('/products', (req, res) => {
  const page = Math.max(1, toIntOrNull(req.query.page) || 1);
  const filters = {
    q: trim(req.query.q, 100),
    category: trim(req.query.category, 100),
    mode: ['stock', 'source'].includes(req.query.mode) ? req.query.mode : '',
    sort: trim(req.query.sort, 20),
  };
  const { items, total } = listProducts({ ...filters, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const category = filters.category ? db.prepare('SELECT * FROM categories WHERE slug = ?').get(filters.category) : null;
  res.render('products', {
    title: category ? category.name : filters.q ? `Search: ${filters.q}` : 'All products',
    items,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    filters,
    category,
  });
});

router.get('/category/:slug', (req, res) => res.redirect(301, `/products?category=${encodeURIComponent(req.params.slug)}`));

router.get('/products/:slug', (req, res) => {
  const product = getProduct({ slug: req.params.slug });
  if (!product || (!product.active && !(req.user && req.user.role !== 'customer'))) {
    return res.status(404).render('error', { title: 'Product not found', message: 'This product is no longer available. Try searching the catalog or send us a sourcing request.' });
  }
  const related = listProducts({ category: product.category_slug, limit: 5 }).items.filter((p) => p.id !== product.id).slice(0, 4);
  res.render('product', { title: product.name, product, specs: parseSpecs(product.specs), related });
});

// ---------- Cart ----------

router.post('/cart/add', (req, res) => {
  const product = getProduct({ id: toIntOrNull(req.body.product_id) });
  const mode = req.body.mode === 'stock' ? 'stock' : 'source';
  if (!product || !product.active || !modeAvailable(product, mode)) {
    flash(req, 'error', 'That product option is not available.');
    return res.redirect(product ? `/products/${product.slug}` : '/products');
  }
  let qty = Math.max(1, toIntOrNull(req.body.qty) || 1);
  if (mode === 'source' && product.moq > 1) qty = Math.max(qty, product.moq);
  if (mode === 'stock' && product.stock_qty !== null && product.stock_qty !== undefined && product.stock_qty > 0) qty = Math.min(qty, product.stock_qty);

  const cart = req.session.cart || [];
  const existing = cart.find((i) => i.id === product.id && i.mode === mode);
  if (existing) existing.qty += qty;
  else if (cart.length >= MAX_CART_LINES) {
    flash(req, 'error', `Your cart can hold up to ${MAX_CART_LINES} different items. Please place this order first.`);
    return res.redirect('/cart');
  } else cart.push({ id: product.id, mode, qty, notes: trim(req.body.notes, 200) });
  req.session.cart = cart;
  flash(req, 'success', `${product.name} added to your cart.`);
  res.redirect(req.body.buy_now ? '/checkout' : '/cart');
});

router.get('/cart', (req, res) => {
  res.render('cart', { title: 'Your cart', ...hydrateCart(req.session.cart) });
});

router.post('/cart/update', (req, res) => {
  const cart = req.session.cart || [];
  cart.forEach((item, i) => {
    const q = toIntOrNull(req.body[`qty_${i}`]);
    if (q !== null) {
      const moq = item.mode === 'source' ? (db.prepare('SELECT moq FROM products WHERE id = ?').get(item.id) || {}).moq || 1 : 1;
      item.qty = Math.max(moq, q);
    }
    if (req.body[`notes_${i}`] !== undefined) item.notes = trim(req.body[`notes_${i}`], 200);
  });
  req.session.cart = cart;
  flash(req, 'success', 'Cart updated.');
  res.redirect('/cart');
});

router.post('/cart/remove', (req, res) => {
  const cart = req.session.cart || [];
  const idx = toIntOrNull(req.body.index);
  if (idx !== null && idx >= 0 && idx < cart.length) cart.splice(idx, 1);
  req.session.cart = cart;
  res.redirect('/cart');
});

// ---------- Checkout ----------

router.get('/checkout', (req, res) => {
  const cart = hydrateCart(req.session.cart);
  if (!cart.lines.length) return res.redirect('/cart');
  const u = req.user || {};
  res.render('checkout', {
    title: 'Checkout',
    ...cart,
    shippingMethods: SHIPPING_METHODS,
    form: { customer_name: u.name, email: u.email, phone: u.phone, company: u.company, country: u.country },
    errors: [],
  });
});

router.post('/checkout', (req, res) => {
  const cart = hydrateCart(req.session.cart);
  if (!cart.lines.length) return res.redirect('/cart');
  const form = {
    customer_name: trim(req.body.customer_name, 120),
    email: trim(req.body.email, 160).toLowerCase(),
    phone: trim(req.body.phone, 40),
    company: trim(req.body.company, 120),
    country: trim(req.body.country, 80),
    city: trim(req.body.city, 80),
    delivery_address: trim(req.body.delivery_address, 500),
    shipping_method: SHIPPING_METHODS.some((m) => m.key === req.body.shipping_method) ? req.body.shipping_method : 'advise',
    notes: trim(req.body.notes, 2000),
  };
  const errors = [];
  if (!form.customer_name) errors.push('Please enter your name.');
  if (!EMAIL_RE.test(form.email)) errors.push('Please enter a valid email address.');
  if (!form.phone) errors.push('Please enter a phone or WhatsApp number so we can reach you.');
  if (!form.country) errors.push('Please enter the destination country.');
  if (errors.length) {
    return res.status(400).render('checkout', { title: 'Checkout', ...cart, shippingMethods: SHIPPING_METHODS, form, errors });
  }

  const ref = makeRef('LH');
  const placeOrder = db.transaction(() => {
    const { lastInsertRowid: orderId } = db
      .prepare(
        `INSERT INTO orders (ref, user_id, customer_name, email, phone, company, country, city, delivery_address, shipping_method, notes, estimate_total)
         VALUES (@ref, @user_id, @customer_name, @email, @phone, @company, @country, @city, @delivery_address, @shipping_method, @notes, @estimate_total)`
      )
      .run({ ...form, ref, user_id: req.user ? req.user.id : null, estimate_total: cart.estimate || null });
    const addItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, product_name, sku, mode, qty, unit, unit_price, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of cart.lines) {
      addItem.run(orderId, l.product.id, l.product.name, l.product.sku, l.mode, l.qty, l.product.unit, l.price ?? null, l.notes || null);
    }
    db.prepare('INSERT INTO order_events (order_id, status, message, created_by) VALUES (?, ?, ?, ?)').run(
      orderId,
      'received',
      'Order placed online.',
      req.user ? req.user.id : null
    );
  });
  placeOrder();

  req.session.cart = [];
  req.session.guestOrders = [...(req.session.guestOrders || []), ref].slice(-20);
  res.redirect(`/orders/${ref}?placed=1`);
});

// ---------- Order view & tracking (guests and customers) ----------

router.get('/orders/:ref', (req, res) => {
  const order = orderForViewer(req, req.params.ref);
  if (!order) {
    flash(req, 'info', 'Enter your order number and email to view this order.');
    return res.redirect(`/track?ref=${encodeURIComponent(req.params.ref)}`);
  }
  res.render('order', { title: `Order ${order.ref}`, ...loadOrderDetail(order), placed: Boolean(req.query.placed) });
});

router.post('/orders/:ref/accept', (req, res) => {
  const order = orderForViewer(req, req.params.ref);
  if (!order) return res.redirect('/track');
  if (order.status !== 'quoted') {
    flash(req, 'error', 'This quotation can no longer be accepted online. Please contact us.');
    return res.redirect(`/orders/${order.ref}`);
  }
  db.prepare("UPDATE orders SET status = 'accepted', updated_at = datetime('now') WHERE id = ?").run(order.id);
  db.prepare('INSERT INTO order_events (order_id, status, message, created_by) VALUES (?, ?, ?, ?)').run(
    order.id,
    'accepted',
    'Customer accepted the quotation online.',
    req.user ? req.user.id : null
  );
  flash(req, 'success', 'Thank you! Quotation accepted. We will send you the invoice and payment details shortly.');
  res.redirect(`/orders/${order.ref}`);
});

router.get('/track', (req, res) => {
  res.render('track', { title: 'Track your order', form: { ref: trim(req.query.ref, 40), email: '' }, error: null });
});

router.post('/track', (req, res) => {
  const ref = trim(req.body.ref, 40).toUpperCase();
  const email = trim(req.body.email, 160).toLowerCase();
  const order = db.prepare('SELECT ref FROM orders WHERE ref = ? AND lower(email) = ?').get(ref, email);
  if (!order) {
    return res.status(404).render('track', { title: 'Track your order', form: { ref, email }, error: 'We could not find an order with that number and email.' });
  }
  req.session.guestOrders = [...(req.session.guestOrders || []), order.ref].slice(-20);
  res.redirect(`/orders/${order.ref}`);
});

// ---------- Custom sourcing requests ----------

router.get('/request', (req, res) => {
  const u = req.user || {};
  res.render('request', {
    title: 'Request a product',
    form: { name: u.name, email: u.email, phone: u.phone, country: u.country, category_id: toIntOrNull(req.query.category), description: trim(req.query.q, 500) },
    errors: [],
  });
});

router.post('/request', ...withUpload(upload.single('image')), (req, res) => {
  const form = {
    name: trim(req.body.name, 120),
    email: trim(req.body.email, 160).toLowerCase(),
    phone: trim(req.body.phone, 40),
    country: trim(req.body.country, 80),
    category_id: toIntOrNull(req.body.category_id),
    description: trim(req.body.description, 4000),
    quantity: trim(req.body.quantity, 120),
    target_price: trim(req.body.target_price, 120),
  };
  const errors = [];
  if (!form.name) errors.push('Please enter your name.');
  if (!EMAIL_RE.test(form.email)) errors.push('Please enter a valid email address.');
  if (!form.description) errors.push('Please describe the product you need.');
  if (form.category_id && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(form.category_id)) form.category_id = null;
  if (errors.length) return res.status(400).render('request', { title: 'Request a product', form, errors });

  const ref = makeRef('RQ');
  db.prepare(
    `INSERT INTO sourcing_requests (ref, user_id, name, email, phone, country, category_id, description, quantity, target_price, image_filename)
     VALUES (@ref, @user_id, @name, @email, @phone, @country, @category_id, @description, @quantity, @target_price, @image)`
  ).run({ ...form, ref, user_id: req.user ? req.user.id : null, image: req.file ? req.file.filename : null });
  res.render('request-sent', { title: 'Request received', ref });
});

router.get('/how-it-works', (req, res) => res.render('how-it-works', { title: 'How it works' }));
router.get('/contact', (req, res) => res.render('contact', { title: 'Contact us' }));

module.exports = router;
