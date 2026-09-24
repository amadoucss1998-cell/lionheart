const { db } = require('./db');

// Returns the order if the current visitor may see it: staff, the owning
// customer, or a guest who placed/looked it up in this browser session.
function orderForViewer(req, ref) {
  const order = db.prepare('SELECT * FROM orders WHERE ref = ?').get(String(ref || '').toUpperCase());
  if (!order) return null;
  if (req.user && (req.user.role !== 'customer' || req.user.id === order.user_id)) return order;
  if ((req.session.guestOrders || []).includes(order.ref)) return order;
  return null;
}

function loadOrderDetail(order) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
  const events = db
    .prepare('SELECT e.*, u.name AS by_name FROM order_events e LEFT JOIN users u ON u.id = e.created_by WHERE order_id = ? ORDER BY e.created_at, e.id')
    .all(order.id);
  return { order, items, events };
}

module.exports = { orderForViewer, loadOrderDetail };
