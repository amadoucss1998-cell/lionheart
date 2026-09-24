// Customer reviews: customers review delivered orders (pending until approved
// by staff), staff can add testimonials, and demo data adds labelled samples.
const { db } = require('./db');

async function approvedReviews(limit = 6) {
  const [items, stats] = await Promise.all([
    db.all("SELECT * FROM reviews WHERE status = 'approved' ORDER BY source = 'sample', created_at DESC, id DESC LIMIT ?", [limit]),
    db.get("SELECT COUNT(*)::int AS count, COALESCE(ROUND(AVG(rating)::numeric, 1), 0)::float AS average FROM reviews WHERE status = 'approved'"),
  ]);
  return { items, stats };
}

function reviewForOrder(orderId) {
  return db.get('SELECT * FROM reviews WHERE order_id = ?', [orderId]);
}

function pendingCount() {
  return db.get("SELECT COUNT(*)::int AS n FROM reviews WHERE status = 'pending'").then((r) => r.n);
}

module.exports = { approvedReviews, reviewForOrder, pendingCount };
