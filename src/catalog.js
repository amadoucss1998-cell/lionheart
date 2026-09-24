const { db } = require('./db');

const PRODUCT_SELECT = `
  SELECT p.*, c.name AS category_name, c.slug AS category_slug, c.icon AS category_icon,
    (SELECT filename FROM product_images i WHERE i.product_id = p.id ORDER BY sort_order, id LIMIT 1) AS image
  FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

async function listProducts({ q, category, mode, featured, sort, limit = 24, offset = 0, includeInactive = false } = {}) {
  const where = [];
  const params = {};
  if (!includeInactive) where.push('p.active = 1');
  if (q) {
    where.push('(p.name ILIKE @q OR p.short_description ILIKE @q OR p.description ILIKE @q OR p.sku ILIKE @q OR c.name ILIKE @q)');
    params.q = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
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
      price_asc: 'COALESCE(p.stock_price, p.china_price) ASC NULLS LAST, p.id',
      price_desc: 'COALESCE(p.stock_price, p.china_price) DESC NULLS LAST, p.id',
      name: 'lower(p.name) ASC',
    }[sort] || 'p.featured DESC, p.created_at DESC, p.id DESC';
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ n: total }, items] = await Promise.all([
    db.get(`SELECT COUNT(*)::int AS n FROM products p LEFT JOIN categories c ON c.id = p.category_id ${whereSql}`, params),
    db.all(`${PRODUCT_SELECT} ${whereSql} ORDER BY ${order} LIMIT @limit OFFSET @offset`, { ...params, limit, offset }),
  ]);
  return { items, total };
}

async function getProduct({ id, slug }) {
  const hasId = id !== null && id !== undefined;
  if (!hasId && !slug) return null;
  const p = hasId ? await db.get(`${PRODUCT_SELECT} WHERE p.id = ?`, [id]) : await db.get(`${PRODUCT_SELECT} WHERE p.slug = ?`, [slug]);
  if (!p) return null;
  p.images = await db.all('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order, id', [p.id]);
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
async function hydrateCart(cart) {
  const items = cart || [];
  const products = await Promise.all(items.map((item) => getProduct({ id: item.id })));
  const lines = [];
  let estimate = 0;
  let hasUnpriced = false;
  items.forEach((item, index) => {
    const product = products[index];
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
