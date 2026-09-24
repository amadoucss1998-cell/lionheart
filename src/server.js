// Load settings from a .env file next to package.json, if there is one.
try {
  process.loadEnvFile(require('path').join(__dirname, '..', '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const { createApp } = require('./app');
const { bootstrap } = require('./seed');
const { db } = require('./db');

const production = process.env.NODE_ENV === 'production';
if (production && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET must be set in production (any long random string). Refusing to start.');
  process.exit(1);
}
if (production && !process.env.PUBLIC_URL) {
  console.warn('PUBLIC_URL is not set; links in alert emails and WhatsApp messages will use the request host.');
}

const port = Number(process.env.PORT) || 3000;
let server;
bootstrap()
  .then(() => {
    server = createApp().listen(port, () => {
      console.log(`Lionheart trade portal running on http://localhost:${port} (${production ? 'production' : 'development'}, database: ${db.kind})`);
    });
  })
  .catch((err) => {
    console.error('Could not start:', err.message);
    process.exit(1);
  });

// Finish in-flight requests and close the database cleanly on redeploys.
function shutdown(signal) {
  console.log(`${signal} received, shutting down…`);
  const done = () => Promise.resolve(db.close()).finally(() => process.exit(0));
  if (server) server.close(done);
  else done();
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
