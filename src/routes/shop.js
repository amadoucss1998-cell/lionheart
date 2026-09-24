const express = require('express');
const { db } = require('../db');
const { listProducts, getProduct, modeAvailable, hydrateCart } = require('../catalog');
const { upload, withUpload, flash } = require('../middleware');
const { SHIPPING_METHODS, makeRef, toIntOrNull, parseSpecs } = require('../helpers');
const { orderForViewer, loadOrderDetail } = require('../orders');
const notify = require('../notify');
const { saveImage } = require('../storage');
const { runInBackground } = require('../background');

const router = express.Router();
const PAGE_SIZE = 24;
const MAX_CART_LINES = 40;

const trim = (v, max = 2000) => String(v || '').trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Used for links in staff alerts when PUBLIC_URL is not set.
const siteUrl = (req) => `${req.protocol}://${req.get('host')}`;

router.get('/', async (req, res) => {
  const [featured, latest, countRows] = await Promise.all([
    listProducts({ featured: true, limit: 8 }),
    listProducts({ sort: 'newest', limit: 8 }),
    db.all('SELECT category_id, COUNT(*)::int AS n FROM products WHERE active = 1 GROUP BY category_id'),
  ]).then(([f, l, c]) => [f.items, l.items, c]);
  const counts = Object.fromEntries(countRows.map((r) => [r.category_id, r.n]));
  const totals = {
    products: countRows.reduce((sum, r) => sum + r.n, 0),
    categories: res.locals.categoriesNav.length,
  };
  res.render('home', { title: null, featured, latest, counts, totals, hero3d: true });
});

router.get('/products', async (req, res) => {
  const page = Math.max(1, toIntOrNull(req.query.page) || 1);
  const filters = {
    q: trim(req.query.q, 100),
    category: trim(req.query.category, 100),
    mode: ['stock', 'source'].includes(req.query.mode) ? req.query.mode : '',
    sort: trim(req.query.sort, 20),
  };
  const [{ items, total }, category] = await Promise.all([
    listProducts({ ...filters, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    filters.category ? db.get('SELECT * FROM categories WHERE slug = ?', [filters.category]) : null,
  ]);
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

router.get('/products/:slug', async (req, res) => {
  const product = await getProduct({ slug: req.params.slug });
  if (!product || (!product.active && !(req.user && req.user.role !== 'customer'))) {
    return res.status(404).render('error', { title: 'Product not found', message: 'This product is no longer available. Try searching the catalog or send us a sourcing request.' });
  }
  const related = (await listProducts({ category: product.category_slug, limit: 5 })).items.filter((p) => p.id !== product.id).slice(0, 4);
  res.render('product', {
    title: product.name,
    description: [product.short_description, product.category_name && `${product.category_name} from Lionheart: order from China or buy from stock.`].filter(Boolean).join('. '),
    shareImage: product.images[0] ? require('../storage').imageUrl(product.images[0].filename) : null,
    product,
    specs: parseSpecs(product.specs),
    related,
  });
});

// ---------- Cart ----------

router.post('/cart/add', async (req, res) => {
  const product = await getProduct({ id: toIntOrNull(req.body.product_id) });
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

router.get('/cart', async (req, res) => {
  res.render('cart', { title: 'Your cart', ...(await hydrateCart(req.session.cart)) });
});

router.post('/cart/update', async (req, res) => {
  const cart = req.session.cart || [];
  const ids = [...new Set(cart.map((i) => i.id))];
  const moqs = new Map(
    ids.length ? (await db.all(`SELECT id, moq FROM products WHERE id IN (${ids.map(() => '?').join(', ')})`, ids)).map((r) => [r.id, r.moq]) : []
  );
  cart.forEach((item, i) => {
    const q = toIntOrNull(req.body[`qty_${i}`]);
    if (q !== null) item.qty = Math.max(item.mode === 'source' ? moqs.get(item.id) || 1 : 1, q);
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

router.get('/checkout', async (req, res) => {
  const cart = await hydrateCart(req.session.cart);
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

router.post('/checkout', async (req, res) => {
  const cart = await hydrateCart(req.session.cart);
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
  const orderId = await db.transaction(async (tx) => {
    const id = await tx.insert(
      `INSERT INTO orders (ref, user_id, customer_name, email, phone, company, country, city, delivery_address, shipping_method, notes, estimate_total)
       VALUES (@ref, @user_id, @customer_name, @email, @phone, @company, @country, @city, @delivery_address, @shipping_method, @notes, @estimate_total)`,
      { ...form, ref, user_id: req.user ? req.user.id : null, estimate_total: cart.estimate || null }
    );
    for (const l of cart.lines) {
      await tx.run(
        `INSERT INTO order_items (order_id, product_id, product_name, sku, mode, qty, unit, unit_price, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, l.product.id, l.product.name, l.product.sku, l.mode, l.qty, l.product.unit, l.price ?? null, l.notes || null]
      );
    }
    await tx.run('INSERT INTO order_events (order_id, status, message, created_by) VALUES (?, ?, ?, ?)', [
      id,
      'received',
      'Order placed online.',
      req.user ? req.user.id : null,
    ]);
    return id;
  });
  runInBackground(notify.notifyNewOrder(orderId, siteUrl(req)));

  req.session.cart = [];
  req.session.guestOrders = [...(req.session.guestOrders || []), ref].slice(-20);
  res.redirect(`/orders/${ref}?placed=1`);
});

// ---------- Order view & tracking (guests and customers) ----------

router.get('/orders/:ref', async (req, res) => {
  const order = await orderForViewer(req, req.params.ref);
  if (!order) {
    flash(req, 'info', 'Enter your order number and email to view this order.');
    return res.redirect(`/track?ref=${encodeURIComponent(req.params.ref)}`);
  }
  res.render('order', { title: `Order ${order.ref}`, ...(await loadOrderDetail(order)), placed: Boolean(req.query.placed) });
});

router.post('/orders/:ref/accept', async (req, res) => {
  const order = await orderForViewer(req, req.params.ref);
  if (!order) return res.redirect('/track');
  if (order.status !== 'quoted') {
    flash(req, 'error', 'This quotation can no longer be accepted online. Please contact us.');
    return res.redirect(`/orders/${order.ref}`);
  }
  // Only a quote that is still open can be accepted (guards against double clicks).
  const { changes } = await db.run("UPDATE orders SET status = 'accepted', updated_at = now() WHERE id = ? AND status = 'quoted'", [order.id]);
  if (changes) {
    await db.run('INSERT INTO order_events (order_id, status, message, created_by) VALUES (?, ?, ?, ?)', [
      order.id,
      'accepted',
      'Customer accepted the quotation online.',
      req.user ? req.user.id : null,
    ]);
  }
  flash(req, 'success', 'Thank you! Quotation accepted. We will send you the invoice and payment details shortly.');
  res.redirect(`/orders/${order.ref}`);
});

router.get('/track', (req, res) => {
  res.render('track', { title: 'Track your order', form: { ref: trim(req.query.ref, 40), email: '' }, error: null });
});

router.post('/track', async (req, res) => {
  const ref = trim(req.body.ref, 40).toUpperCase();
  const email = trim(req.body.email, 160).toLowerCase();
  const order = await db.get('SELECT ref FROM orders WHERE ref = ? AND lower(email) = ?', [ref, email]);
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

router.post('/request', ...withUpload(upload.single('image')), async (req, res) => {
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
  if (form.category_id && !(await db.get('SELECT 1 AS ok FROM categories WHERE id = ?', [form.category_id]))) form.category_id = null;
  if (errors.length) return res.status(400).render('request', { title: 'Request a product', form, errors });

  const ref = makeRef('RQ');
  const image = req.file ? await saveImage(req.file, 'requests') : null;
  const requestId = await db.insert(
    `INSERT INTO sourcing_requests (ref, user_id, name, email, phone, country, category_id, description, quantity, target_price, image_filename)
     VALUES (@ref, @user_id, @name, @email, @phone, @country, @category_id, @description, @quantity, @target_price, @image)`,
    { ...form, ref, user_id: req.user ? req.user.id : null, image }
  );
  runInBackground(notify.notifyNewRequest(requestId, siteUrl(req)));
  res.render('request-sent', { title: 'Request received', ref });
});

// ---------- Search engines ----------

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /account\nDisallow: /cart\nDisallow: /checkout\nDisallow: /orders/\nSitemap: ${res.locals.siteUrl}/sitemap.xml\n`);
});

router.get('/sitemap.xml', async (req, res) => {
  const base = res.locals.siteUrl;
  const products = await db.all('SELECT slug, updated_at FROM products WHERE active = 1 ORDER BY id');
  const urls = [
    ['/', null],
    ['/products', null],
    ['/how-it-works', null],
    ['/request', null],
    ['/contact', null],
    ...res.locals.categoriesNav.map((c) => [`/products?category=${encodeURIComponent(c.slug)}`, null]),
    ...products.map((p) => [`/products/${p.slug}`, p.updated_at]),
  ];
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const body = urls
    .map(([u, d]) => `  <url><loc>${esc(base + u)}</loc>${d ? `<lastmod>${new Date(d).toISOString().slice(0, 10)}</lastmod>` : ''}</url>`)
    .join('\n');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
});

// Unlisted product tour for presenting the platform to a client.
router.get('/tour', (req, res) =>
  res.render('tour', { title: 'Platform tour', description: 'A guided tour of the Lionheart trade platform: customer shop, quotations, order tracking and the team admin.', noindex: true })
);

router.get('/how-it-works', (req, res) => res.render('how-it-works', { title: 'How it works' }));
router.get('/contact', (req, res) => res.render('contact', { title: 'Contact us' }));

module.exports = router;
