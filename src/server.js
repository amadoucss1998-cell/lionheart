const { createApp } = require('./app');
const { ensureAdmin, seedCatalog } = require('./seed');

ensureAdmin();
if (process.env.SEED_DEMO !== 'false') seedCatalog();

const port = Number(process.env.PORT) || 3000;
createApp().listen(port, () => {
  console.log(`Lionheart trade portal running on http://localhost:${port}`);
});
