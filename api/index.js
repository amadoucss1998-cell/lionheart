// Vercel entry point: every request that isn't a static file in public/ is
// handled by the Express app (see vercel.json).
const { createApp } = require('../src/app');

module.exports = createApp();
