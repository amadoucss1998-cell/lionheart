// Small in-memory rate limiter (per client IP and route). Fine for a single
// server process; counts reset when the server restarts.
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  const disabled = process.env.RATE_LIMIT === 'off';

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs);
  sweep.unref();

  return function limiter(req, res, next) {
    if (disabled) return next();
    const now = Date.now();
    const key = req.ip;
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count <= max) return next();
    res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
    res.status(429).render('error', {
      title: 'Too many requests',
      message: message || 'You have sent too many requests. Please wait a while and try again.',
    });
  };
}

module.exports = { rateLimit };
