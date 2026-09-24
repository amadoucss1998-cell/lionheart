// Tiny in-memory cache for public catalog data (home page, catalog listings,
// product pages). Entries expire after a short time and are cleared
// immediately when staff change anything in the admin (see clearCatalogCache).
// Each server instance (e.g. each Vercel function) has its own copy.
const MAX_ENTRIES = 300;
const store = new Map();

async function cached(key, ttlMs, load) {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await load();
  if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

function clearCache() {
  store.clear();
}

module.exports = { cached, clearCache };
