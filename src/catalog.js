const { db } = require('./db');

const PRODUCT_SELECT = `
  SELECT p.*, c.name AS category_name, c.slug AS category_slug, c.icon AS category_icon,
    (SELECT filename FROM product_images i WHERE i.product_id = p.id ORDER BY sort_order, id LIMIT 1) AS image
  FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

function listProducts({ q, category, mode, featured, sort, limit = 24, offset = 0, includeInactive = false } = {}) {
  const where = [];
  const params = {};
  if (!includeInactive) where.push('p.active = 1');
  if (q) {
    where.push('(p.name LIKE @q OR p.short_description LIKE @q OR p.description LIKE @q OR p.sku LIKE @q OR c.name LIKE @q)');
    params.q = `%${q}%`;
  }
  if (category) {
    where.push('c.slug = @category');
    params.category = category;
  }
  if (mode === 'stock') where.push('p.stock_available = 1');
  if (mode === 'source') where.push('p.sourcing_available = 1');
  if (featured) where.push('p.featured = 1');
  const order =
    {
      newest: 'p.created_at DESC, p.id DESC',
      price_asc: 'COALESCE(p.stock_price, p.china_price) IS NULL, COALESCE(p.stock_price, p.china_price) ASC',
      price_desc: 'COALESCE(p.stock_price, p.china_price) DESC',
      name: 'p.name COLLATE NOCASE ASC',
    }[sort] || 'p.featured DESC, p.created_at DESC, p.id DESC';
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM products p LEFT JOIN categories c ON c.id = p.category_id ${whereSql}`).get(params).n;
  const items = db.prepare(`${PRODUCT_SELECT} ${whereSql} ORDER BY ${order} LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset });
  return { items, total };
}

function getProduct({ id, slug }) {
  const p = id
    ? db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id)
    : db.prepare(`${PRODUCT_SELECT} WHERE p.slug = ?`).get(slug);
  if (!p) return null;
  p.images = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order, id').all(p.id);
  return p;
}

// Price for a given purchase mode; null means "price on request".
function unitPrice(product, mode) {
  if (mode === 'stock') return product.stock_available ? product.stock_price : null;
  return product.sourcing_available ? product.china_price : null;
}

function modeAvailable(product, mode) {
  return mode === 'stock' ? Boolean(product.stock_available) : Boolean(product.sourcing_available);
}

// Turns the session cart ([{ id, mode, qty, notes }]) into display lines.
function hydrateCart(cart) {
  const lines = [];
  let estimate = 0;
  let hasUnpriced = false;
  (cart || []).forEach((item, index) => {
    const product = getProduct({ id: item.id });
    if (!product || !product.active || !modeAvailable(product, item.mode)) return;
    const price = unitPrice(product, item.mode);
    const lineTotal = price !== null && price !== undefined ? price * item.qty : null;
    if (lineTotal === null) hasUnpriced = true;
    else estimate += lineTotal;
    lines.push({ index, product, mode: item.mode, qty: item.qty, notes: item.notes || '', price, lineTotal });
  });
  return { lines, estimate, hasUnpriced };
}

module.exports = { listProducts, getProduct, unitPrice, modeAvailable, hydrateCart };
