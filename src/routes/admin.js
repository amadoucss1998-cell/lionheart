const express = require('express');
const bcrypt = require('bcryptjs');
const { db, getSettings, setSetting, DEFAULT_SETTINGS } = require('../db');
const { upload, csvUpload, withUpload, flash, requireStaff, requireAdmin, removeUpload } = require('../middleware');
const { listProducts, getProduct } = require('../catalog');
const { loadOrderDetail } = require('../orders');
const h = require('../helpers');

const router = express.Router();
router.use(requireStaff);

const trim = (v, max = 4000) => String(v || '').trim().slice(0, max);
const checkbox = (v) => (v ? 1 : 0);

router.get('/', (req, res) => {
  const stats = {
    products: db.prepare('SELECT COUNT(*) AS n FROM products WHERE active = 1').get().n,
    ordersOpen: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status NOT IN ('delivered','cancelled')").get().n,
    ordersNew: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'received'").get().n,
    requestsNew: db.prepare("SELECT COUNT(*) AS n FROM sourcing_requests WHERE status = 'new'").get().n,
    customers: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'").get().n,
    suppliers: db.prepare('SELECT COUNT(*) AS n FROM suppliers').get().n,
  };
  const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all();
  const recentOrders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 8').all();
  const recentRequests = db.prepare('SELECT * FROM sourcing_requests ORDER BY created_at DESC, id DESC LIMIT 5').all();
  res.render('admin/dashboard', { title: 'Dashboard', stats, byStatus, recentOrders, recentRequests });
});

// ---------------- Products ----------------

router.get('/products', (req, res) => {
  const q = trim(req.query.q, 100);
  const category = trim(req.query.category, 100);
  const { items, total } = listProducts({ q, category, sort: 'newest', limit: 500, includeInactive: true });
  res.render('admin/products', { title: 'Products', items, total, q, category });
});

function productFormData() {
  return {
    categories: db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all(),
    suppliers: db.prepare('SELECT id, name, city FROM suppliers ORDER BY name').all(),
  };
}

function readProductForm(body) {
  return {
    name: trim(body.name, 200),
    sku: trim(body.sku, 60) || null,
    category_id: h.toIntOrNull(body.category_id),
    supplier_id: h.toIntOrNull(body.supplier_id),
    short_description: trim(body.short_description, 300),
    description: trim(body.description, 20000),
    specs: trim(body.specs, 10000),
    unit: trim(body.unit, 40) || 'piece',
    moq: Math.max(1, h.toIntOrNull(body.moq) || 1),
    sourcing_available: checkbox(body.sourcing_available),
    china_price: h.toNumberOrNull(body.china_price),
    china_lead_days: h.toIntOrNull(body.china_lead_days),
    stock_available: checkbox(body.stock_available),
    stock_price: h.toNumberOrNull(body.stock_price),
    stock_qty: h.toIntOrNull(body.stock_qty),
    stock_location: trim(body.stock_location, 80),
    featured: checkbox(body.featured),
    active: checkbox(body.active),
  };
}

function validateProduct(p, id) {
  const errors = [];
  if (!p.name) errors.push('Product name is required.');
  if (!p.sourcing_available && !p.stock_available) errors.push('Enable at least one way to buy: China sourcing or Lionheart stock.');
  if (p.sku && db.prepare('SELECT id FROM products WHERE sku = ? AND id IS NOT ?').get(p.sku, id || null)) errors.push('Another product already uses this SKU.');
  return errors;
}

function saveImages(productId, files) {
  const start = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM product_images WHERE product_id = ?').get(productId).n;
  const stmt = db.prepare('INSERT INTO product_images (product_id, filename, sort_order) VALUES (?, ?, ?)');
  (files || []).forEach((f, i) => stmt.run(productId, f.filename, start + i));
}

const blankProduct = { active: 1, sourcing_available: 1, stock_available: 0, unit: 'piece', moq: 1, images: [] };

router.get('/products/new', (req, res) => {
  res.render('admin/product-form', { title: 'Add product', product: blankProduct, errors: [], ...productFormData() });
});

router.post('/products/new', ...withUpload(upload.array('images', 12)), (req, res) => {
  const p = readProductForm(req.body);
  const errors = validateProduct(p);
  if (errors.length) {
    (req.files || []).forEach((f) => removeUpload(f.filename));
    return res.status(400).render('admin/product-form', { title: 'Add product', product: { ...p, images: [] }, errors, ...productFormData() });
  }
  const slug = h.uniqueSlug(db, 'products', p.name);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO products (sku, name, slug, category_id, supplier_id, short_description, description, specs, unit, moq,
        sourcing_available, china_price, china_lead_days, stock_available, stock_price, stock_qty, stock_location, featured, active)
       VALUES (@sku, @name, @slug, @category_id, @supplier_id, @short_description, @description, @specs, @unit, @moq,
        @sourcing_available, @china_price, @china_lead_days, @stock_available, @stock_price, @stock_qty, @stock_location, @featured, @active)`
    )
    .run({ ...p, slug });
  saveImages(lastInsertRowid, req.files);
  flash(req, 'success', `Product "${p.name}" created.`);
  res.redirect(req.body.save_and_new ? '/admin/products/new' : `/admin/products/${lastInsertRowid}`);
});

router.get('/products/:id', (req, res) => {
  const product = getProduct({ id: h.toIntOrNull(req.params.id) });
  if (!product) return res.status(404).render('error', { title: 'Not found', message: 'Product not found.' });
  res.render('admin/product-form', { title: `Edit: ${product.name}`, product, errors: [], ...productFormData() });
});

router.post('/products/:id', ...withUpload(upload.array('images', 12)), (req, res) => {
  const existing = getProduct({ id: h.toIntOrNull(req.params.id) });
  if (!existing) return res.status(404).render('error', { title: 'Not found', message: 'Product not found.' });
  const p = readProductForm(req.body);
  const errors = validateProduct(p, existing.id);
  if (errors.length) {
    (req.files || []).forEach((f) => removeUpload(f.filename));
    return res.status(400).render('admin/product-form', { title: `Edit: ${existing.name}`, product: { ...existing, ...p }, errors, ...productFormData() });
  }
  const slug = p.name === existing.name ? existing.slug : h.uniqueSlug(db, 'products', p.name, existing.id);
  db.prepare(
    `UPDATE products SET sku=@sku, name=@name, slug=@slug, category_id=@category_id, supplier_id=@supplier_id,
      short_description=@short_description, description=@description, specs=@specs, unit=@unit, moq=@moq,
      sourcing_available=@sourcing_available, china_price=@china_price, china_lead_days=@china_lead_days,
      stock_available=@stock_available, stock_price=@stock_price, stock_qty=@stock_qty, stock_location=@stock_location,
      featured=@featured, active=@active, updated_at=datetime('now') WHERE id=@id`
  ).run({ ...p, slug, id: existing.id });

  const removeIds = [].concat(req.body.remove_image || []).map(h.toIntOrNull).filter(Boolean);
  for (const imgId of removeIds) {
    const img = db.prepare('SELECT * FROM product_images WHERE id = ? AND product_id = ?').get(imgId, existing.id);
    if (img) {
      db.prepare('DELETE FROM product_images WHERE id = ?').run(img.id);
      removeUpload(img.filename);
    }
  }
  const mainId = h.toIntOrNull(req.body.main_image);
  if (mainId) {
    db.prepare('UPDATE product_images SET sort_order = sort_order + 1 WHERE product_id = ?').run(existing.id);
    db.prepare('UPDATE product_images SET sort_order = 0 WHERE id = ? AND product_id = ?').run(mainId, existing.id);
  }
  saveImages(existing.id, req.files);
  flash(req, 'success', 'Product saved.');
  res.redirect(`/admin/products/${existing.id}`);
});

router.post('/products/:id/duplicate', (req, res) => {
  const src = getProduct({ id: h.toIntOrNull(req.params.id) });
  if (!src) return res.redirect('/admin/products');
  const name = `${src.name} (copy)`;
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO products (sku, name, slug, category_id, supplier_id, short_description, description, specs, unit, moq,
        sourcing_available, china_price, china_lead_days, stock_available, stock_price, stock_qty, stock_location, featured, active)
       SELECT NULL, ?, ?, category_id, supplier_id, short_description, description, specs, unit, moq,
        sourcing_available, china_price, china_lead_days, stock_available, stock_price, stock_qty, stock_location, 0, 0
       FROM products WHERE id = ?`
    )
    .run(name, h.uniqueSlug(db, 'products', name), src.id);
  flash(req, 'success', 'Copy created (hidden until you activate it). Add photos and adjust the details.');
  res.redirect(`/admin/products/${lastInsertRowid}`);
});

router.post('/products/:id/delete', (req, res) => {
  const product = getProduct({ id: h.toIntOrNull(req.params.id) });
  if (product) {
    db.prepare('DELETE FROM products WHERE id = ?').run(product.id);
    product.images.forEach((img) => removeUpload(img.filename));
    flash(req, 'success', `Deleted "${product.name}". Past orders keep their copy of the product name.`);
  }
  res.redirect('/admin/products');
});

// ---- Bulk import ----

const CSV_COLUMNS = [
  'name', 'sku', 'category', 'supplier', 'short_description', 'description', 'specs', 'unit', 'moq',
  'sourcing_available', 'china_price', 'china_lead_days', 'stock_available', 'stock_price', 'stock_qty', 'stock_location', 'featured',
];

router.get('/products-import', (req, res) => {
  res.render('admin/import', { title: 'Bulk import products', columns: CSV_COLUMNS, result: null });
});

router.get('/products-import/template.csv', (req, res) => {
  const sample = [
    CSV_COLUMNS,
    ['Porcelain Floor Tile 60x60 Polished', 'TL-6060-P', 'Tiles & Ceramics', '', 'Glossy polished porcelain tile', 'High quality polished porcelain tile for living rooms and offices.',
      'Size: 600x600mm\nThickness: 9.5mm\nFinish: Polished', 'sqm', '200', 'yes', '6.80', '25', 'yes', '11.50', '1500', 'Dubai warehouse', 'no'],
  ];
  res.type('text/csv').attachment('lionheart-products-template.csv').send(sample.map((r) => r.map(h.csvEscape).join(',')).join('\r\n'));
});

const yes = (v) => /^(1|y|yes|true|x)$/i.test(String(v || '').trim());

router.post('/products-import', ...withUpload(csvUpload.single('file')), (req, res) => {
  if (!req.file) {
    flash(req, 'error', 'Please choose a CSV file.');
    return res.redirect('/admin/products-import');
  }
  const rows = h.parseCSV(req.file.buffer.toString('utf8'));
  const result = { created: 0, updated: 0, errors: [] };
  const catByName = new Map(db.prepare('SELECT id, name, slug FROM categories').all().flatMap((c) => [[c.name.toLowerCase(), c.id], [c.slug, c.id]]));
  const supByName = new Map(db.prepare('SELECT id, name FROM suppliers').all().map((s) => [s.name.toLowerCase(), s.id]));

  const run = db.transaction(() => {
    rows.forEach((r, i) => {
      const line = i + 2;
      if (!r.name) return result.errors.push(`Line ${line}: missing name — skipped.`);
      let categoryId = null;
      if (r.category) {
        categoryId = catByName.get(r.category.toLowerCase()) || catByName.get(h.slugify(r.category));
        if (!categoryId) {
          const slug = h.uniqueSlug(db, 'categories', r.category);
          categoryId = db.prepare('INSERT INTO categories (name, slug, icon, sort_order) VALUES (?, ?, ?, 100)').run(r.category, slug, 'box').lastInsertRowid;
          catByName.set(r.category.toLowerCase(), categoryId);
        }
      }
      let supplierId = null;
      if (r.supplier) {
        supplierId = supByName.get(r.supplier.toLowerCase());
        if (!supplierId) {
          supplierId = db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(r.supplier).lastInsertRowid;
          supByName.set(r.supplier.toLowerCase(), supplierId);
        }
      }
      const stockAvailable = r.stock_available ? yes(r.stock_available) : h.toNumberOrNull(r.stock_price) !== null;
      const p = {
        name: r.name.slice(0, 200),
        sku: r.sku || null,
        category_id: categoryId,
        supplier_id: supplierId,
        short_description: r.short_description || '',
        description: r.description || '',
        specs: (r.specs || '').replace(/\s*\|\s*/g, '\n'),
        unit: r.unit || 'piece',
        moq: Math.max(1, h.toIntOrNull(r.moq) || 1),
        sourcing_available: r.sourcing_available ? (yes(r.sourcing_available) ? 1 : 0) : 1,
        china_price: h.toNumberOrNull(r.china_price),
        china_lead_days: h.toIntOrNull(r.china_lead_days),
        stock_available: stockAvailable ? 1 : 0,
        stock_price: h.toNumberOrNull(r.stock_price),
        stock_qty: h.toIntOrNull(r.stock_qty),
        stock_location: r.stock_location || '',
        featured: yes(r.featured) ? 1 : 0,
      };
      if (!p.sourcing_available && !p.stock_available) p.sourcing_available = 1;
      const existing = p.sku ? db.prepare('SELECT id FROM products WHERE sku = ?').get(p.sku) : null;
      if (existing) {
        db.prepare(
          `UPDATE products SET name=@name, category_id=@category_id, supplier_id=COALESCE(@supplier_id, supplier_id), short_description=@short_description,
            description=@description, specs=@specs, unit=@unit, moq=@moq, sourcing_available=@sourcing_available, china_price=@china_price,
            china_lead_days=@china_lead_days, stock_available=@stock_available, stock_price=@stock_price, stock_qty=@stock_qty,
            stock_location=@stock_location, featured=@featured, updated_at=datetime('now') WHERE id=@id`
        ).run({ ...p, id: existing.id });
        result.updated++;
      } else {
        db.prepare(
          `INSERT INTO products (sku, name, slug, category_id, supplier_id, short_description, description, specs, unit, moq,
            sourcing_available, china_price, china_lead_days, stock_available, stock_price, stock_qty, stock_location, featured)
           VALUES (@sku, @name, @slug, @category_id, @supplier_id, @short_description, @description, @specs, @unit, @moq,
            @sourcing_available, @china_price, @china_lead_days, @stock_available, @stock_price, @stock_qty, @stock_location, @featured)`
        ).run({ ...p, slug: h.uniqueSlug(db, 'products', p.name) });
        result.created++;
      }
    });
  });
  run();
  res.render('admin/import', { title: 'Bulk import products', columns: CSV_COLUMNS, result });
});

// ---------------- Categories ----------------

const ICONS = ['cpu', 'cog', 'truck', 'car', 'sofa', 'bricks', 'grid', 'droplet', 'roof', 'door', 'bolt', 'sun', 'box', 'shirt', 'tool', 'leaf'];

router.get('/categories', (req, res) => {
  const categories = db
    .prepare('SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count FROM categories c ORDER BY sort_order, name')
    .all();
  res.render('admin/categories', { title: 'Categories', categories, icons: ICONS });
});

router.post('/categories', (req, res) => {
  const name = trim(req.body.name, 100);
  if (!name) {
    flash(req, 'error', 'Category name is required.');
    return res.redirect('/admin/categories');
  }
  const id = h.toIntOrNull(req.body.id);
  const data = {
    name,
    description: trim(req.body.description, 500),
    icon: ICONS.includes(req.body.icon) ? req.body.icon : 'box',
    sort_order: h.toIntOrNull(req.body.sort_order) || 0,
  };
  if (id) {
    db.prepare('UPDATE categories SET name=@name, description=@description, icon=@icon, sort_order=@sort_order WHERE id=@id').run({ ...data, id });
  } else {
    db.prepare('INSERT INTO categories (name, slug, description, icon, sort_order) VALUES (@name, @slug, @description, @icon, @sort_order)').run({
      ...data,
      slug: h.uniqueSlug(db, 'categories', name),
    });
  }
  flash(req, 'success', 'Category saved.');
  res.redirect('/admin/categories');
});

router.post('/categories/:id/delete', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(h.toIntOrNull(req.params.id));
  flash(req, 'success', 'Category deleted. Its products are now uncategorised.');
  res.redirect('/admin/categories');
});

// ---------------- Suppliers ----------------

router.get('/suppliers', (req, res) => {
  const suppliers = db
    .prepare('SELECT s.*, (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id) AS product_count FROM suppliers s ORDER BY name')
    .all();
  const editing = req.query.edit ? db.prepare('SELECT * FROM suppliers WHERE id = ?').get(h.toIntOrNull(req.query.edit)) : null;
  res.render('admin/suppliers', { title: 'Suppliers', suppliers, editing });
});

router.post('/suppliers', (req, res) => {
  const data = {
    name: trim(req.body.name, 160),
    contact_person: trim(req.body.contact_person, 120),
    phone: trim(req.body.phone, 60),
    email: trim(req.body.email, 160),
    wechat: trim(req.body.wechat, 80),
    city: trim(req.body.city, 80),
    country: trim(req.body.country, 80) || 'China',
    notes: trim(req.body.notes, 4000),
  };
  if (!data.name) {
    flash(req, 'error', 'Supplier name is required.');
    return res.redirect('/admin/suppliers');
  }
  const id = h.toIntOrNull(req.body.id);
  if (id) {
    db.prepare(
      'UPDATE suppliers SET name=@name, contact_person=@contact_person, phone=@phone, email=@email, wechat=@wechat, city=@city, country=@country, notes=@notes WHERE id=@id'
    ).run({ ...data, id });
  } else {
    db.prepare(
      'INSERT INTO suppliers (name, contact_person, phone, email, wechat, city, country, notes) VALUES (@name, @contact_person, @phone, @email, @wechat, @city, @country, @notes)'
    ).run(data);
  }
  flash(req, 'success', 'Supplier saved.');
  res.redirect('/admin/suppliers');
});

router.post('/suppliers/:id/delete', (req, res) => {
  db.prepare('DELETE FROM suppliers WHERE id = ?').run(h.toIntOrNull(req.params.id));
  flash(req, 'success', 'Supplier deleted.');
  res.redirect('/admin/suppliers');
});

// ---------------- Orders ----------------

router.get('/orders', (req, res) => {
  const status = h.STATUS_KEYS.includes(req.query.status) ? req.query.status : '';
  const q = trim(req.query.q, 100);
  const where = [];
  const params = {};
  if (status) { where.push('o.status = @status'); params.status = status; }
  if (q) { where.push('(o.ref LIKE @q OR o.customer_name LIKE @q OR o.email LIKE @q OR o.phone LIKE @q OR o.company LIKE @q)'); params.q = `%${q}%`; }
  const orders = db
    .prepare(
      `SELECT o.*, (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count,
        (SELECT GROUP_CONCAT(DISTINCT mode) FROM order_items i WHERE i.order_id = o.id) AS modes
       FROM orders o ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.created_at DESC, o.id DESC LIMIT 500`
    )
    .all(params);
  res.render('admin/orders', { title: 'Orders', orders, status, q });
});

router.get('/orders.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  const cols = ['ref', 'created_at', 'status', 'customer_name', 'email', 'phone', 'company', 'country', 'city', 'shipping_method', 'estimate_total', 'goods_total', 'shipping_cost', 'other_charges', 'quoted_total', 'tracking_number'];
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => h.csvEscape(r[c])).join(','))].join('\r\n');
  res.type('text/csv').attachment('lionheart-orders.csv').send(csv);
});

function findOrder(ref) {
  return db.prepare('SELECT * FROM orders WHERE ref = ?').get(String(ref || '').toUpperCase());
}

router.get('/orders/:ref', (req, res) => {
  const order = findOrder(req.params.ref);
  if (!order) return res.status(404).render('error', { title: 'Not found', message: 'Order not found.' });
  const detail = loadOrderDetail(order);
  const supplierFor = db.prepare('SELECT s.* FROM products p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?');
  detail.items.forEach((i) => { i.supplier = i.product_id ? supplierFor.get(i.product_id) : null; });
  res.render('admin/order', { title: `Order ${order.ref}`, ...detail });
});

// Update pricing / quotation
router.post('/orders/:ref/quote', (req, res) => {
  const order = findOrder(req.params.ref);
  if (!order) return res.redirect('/admin/orders');
  const items = db.prepare('SELECT id FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
  const prices = [].concat(req.body.unit_price || []);
  const setPrice = db.prepare('UPDATE order_items SET unit_price = ? WHERE id = ? AND order_id = ?');
  items.forEach((it, i) => setPrice.run(h.toNumberOrNull(prices[i]), it.id, order.id));
  const goods = db.prepare('SELECT SUM(unit_price * qty) AS t, SUM(unit_price IS NULL) AS missing FROM order_items WHERE order_id = ?').get(order.id);
  const shipping = h.toNumberOrNull(req.body.shipping_cost);
  const other = h.toNumberOrNull(req.body.other_charges);
  const goodsTotal = goods.t || 0;
  const quoted = h.toNumberOrNull(req.body.quoted_total) ?? goodsTotal + (shipping || 0) + (other || 0);
  db.prepare(
    "UPDATE orders SET goods_total = ?, shipping_cost = ?, other_charges = ?, quoted_total = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(goodsTotal, shipping, other, quoted, order.id);

  if (req.body.send_quote) {
    if (goods.missing) {
      flash(req, 'error', 'Prices saved, but every item needs a unit price before the quotation can be sent.');
      return res.redirect(`/admin/orders/${order.ref}`);
    }
    const msg = trim(req.body.quote_message, 2000) || 'Your quotation is ready. Please review the prices and accept to proceed.';
    db.prepare("UPDATE orders SET status = 'quoted', customer_message = ?, updated_at = datetime('now') WHERE id = ?").run(msg, order.id);
    db.prepare('INSERT INTO order_events (order_id, status, message, created_by) VALUES (?, ?, ?, ?)').run(order.id, 'quoted', msg, req.user.id);
    flash(req, 'success', 'Quotation sent. The customer can now see and accept it from their order page.');
  } else flash(req, 'success', 'Prices saved.');
  res.redirect(`/admin/orders/${order.ref}`);
});

router.post('/orders/:ref/status', (req, res) => {
  const order = findOrder(req.params.ref);
  if (!order) return res.redirect('/admin/orders');
  const status = h.STATUS_KEYS.includes(req.body.status) ? req.body.status : order.status;
  const message = trim(req.body.message, 2000);
  const tracking = trim(req.body.tracking_number, 120);
  db.prepare(
    "UPDATE orders SET status = ?, tracking_number = ?, customer_message = COALESCE(NULLIF(?, ''), customer_message), updated_at = datetime('now') WHERE id = ?"
  ).run(status, tracking || null, message, order.id);
  if (status !== order.status || message) {
    db.prepare('INSERT INTO order_events (order_id, status, message, created_by) VALUES (?, ?, ?, ?)').run(order.id, status, message || null, req.user.id);
  }
  flash(req, 'success', `Order updated: ${h.statusLabel(status)}.`);
  res.redirect(`/admin/orders/${order.ref}`);
});

router.post('/orders/:ref/notes', (req, res) => {
  const order = findOrder(req.params.ref);
  if (!order) return res.redirect('/admin/orders');
  db.prepare("UPDATE orders SET internal_notes = ?, updated_at = datetime('now') WHERE id = ?").run(trim(req.body.internal_notes, 10000), order.id);
  flash(req, 'success', 'Internal notes saved.');
  res.redirect(`/admin/orders/${order.ref}`);
});

// ---------------- Sourcing requests ----------------

router.get('/requests', (req, res) => {
  const requests = db
    .prepare('SELECT r.*, c.name AS category_name FROM sourcing_requests r LEFT JOIN categories c ON c.id = r.category_id ORDER BY r.created_at DESC, r.id DESC LIMIT 500')
    .all();
  res.render('admin/requests', { title: 'Sourcing requests', requests });
});

router.get('/requests/:ref', (req, res) => {
  const request = db
    .prepare('SELECT r.*, c.name AS category_name FROM sourcing_requests r LEFT JOIN categories c ON c.id = r.category_id WHERE r.ref = ?')
    .get(String(req.params.ref).toUpperCase());
  if (!request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });
  res.render('admin/request', { title: `Request ${request.ref}`, request });
});

router.post('/requests/:ref', (req, res) => {
  const status = h.SOURCING_STATUSES.some((s) => s.key === req.body.status) ? req.body.status : 'new';
  db.prepare("UPDATE sourcing_requests SET status = ?, admin_reply = ?, updated_at = datetime('now') WHERE ref = ?").run(
    status,
    trim(req.body.admin_reply, 4000),
    String(req.params.ref).toUpperCase()
  );
  flash(req, 'success', 'Request updated.');
  res.redirect(`/admin/requests/${encodeURIComponent(req.params.ref)}`);
});

// ---------------- Customers & staff ----------------

router.get('/customers', (req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.phone, u.company, u.country, u.role, u.created_at,
        (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
       FROM users u ORDER BY u.role = 'customer', u.created_at DESC`
    )
    .all();
  res.render('admin/customers', { title: 'Customers & team', users });
});

router.post('/users', requireAdmin, (req, res) => {
  const email = trim(req.body.email, 160).toLowerCase();
  const name = trim(req.body.name, 120);
  const password = String(req.body.password || '');
  const role = ['staff', 'admin'].includes(req.body.role) ? req.body.role : 'staff';
  if (!name || !email || password.length < 8) {
    flash(req, 'error', 'Name, email and a password of at least 8 characters are required.');
  } else if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    flash(req, 'error', 'A user with that email already exists.');
  } else {
    db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(name, email, bcrypt.hashSync(password, 10), role);
    flash(req, 'success', `Team member ${name} added.`);
  }
  res.redirect('/admin/customers');
});

router.post('/users/:id/role', requireAdmin, (req, res) => {
  const id = h.toIntOrNull(req.params.id);
  const role = ['customer', 'staff', 'admin'].includes(req.body.role) ? req.body.role : null;
  if (id === req.user.id) flash(req, 'error', 'You cannot change your own role.');
  else if (role) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    flash(req, 'success', 'Role updated.');
  }
  res.redirect('/admin/customers');
});

// ---------------- Settings ----------------

router.get('/settings', requireAdmin, (req, res) => {
  res.render('admin/settings', { title: 'Settings', values: getSettings(), keys: Object.keys(DEFAULT_SETTINGS) });
});

router.post('/settings', requireAdmin, (req, res) => {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (req.body[key] !== undefined) setSetting(key, trim(req.body[key], 4000));
  }
  flash(req, 'success', 'Settings saved.');
  res.redirect('/admin/settings');
});

module.exports = router;
