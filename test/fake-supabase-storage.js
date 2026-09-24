// A stand-in for the Supabase Storage REST API (the endpoints this app uses),
// for tests and local end-to-end checks without a Supabase project.
const http = require('http');

function createFakeSupabaseStorage() {
  const buckets = new Map();
  const objects = new Map(); // "bucket/path" -> { type, body }
  const calls = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: url.pathname, auth: req.headers.authorization });
      const json = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      let m;
      if (req.method === 'GET' && (m = url.pathname.match(/^\/storage\/v1\/bucket\/([^/]+)$/))) {
        return buckets.has(m[1]) ? json(200, buckets.get(m[1])) : json(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
      }
      if (req.method === 'POST' && url.pathname === '/storage/v1/bucket') {
        const b = JSON.parse(body);
        buckets.set(b.id, b);
        return json(200, { name: b.id });
      }
      if (req.method === 'POST' && (m = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/))) {
        if (!buckets.has(m[1])) return json(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
        objects.set(`${m[1]}/${decodeURIComponent(m[2])}`, { type: req.headers['content-type'], body });
        return json(200, { Id: '1', Key: `${m[1]}/${m[2]}` });
      }
      if (req.method === 'DELETE' && (m = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)$/))) {
        const { prefixes } = JSON.parse(body);
        prefixes.forEach((p) => objects.delete(`${m[1]}/${p}`));
        return json(200, prefixes.map((name) => ({ name })));
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/))) {
        const o = objects.get(`${m[1]}/${decodeURIComponent(m[2])}`);
        if (!o) return json(404, { message: 'not found' });
        res.writeHead(200, { 'content-type': o.type });
        return res.end(o.body);
      }
      json(404, { message: `unhandled ${req.method} ${url.pathname}` });
    });
  });

  return { server, buckets, objects, calls };
}

module.exports = { createFakeSupabaseStorage };

// Run standalone:  node test/fake-supabase-storage.js 54321
if (require.main === module) {
  const { server } = createFakeSupabaseStorage();
  server.listen(Number(process.argv[2]) || 54321, '127.0.0.1', () => console.log(`Fake Supabase Storage on http://127.0.0.1:${server.address().port}`));
}
