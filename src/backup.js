// Database backup.
//  - Supabase: backups are automatic (daily, see Supabase → Database → Backups).
//    For your own copy run:  pg_dump "$DATABASE_URL" > lionheart.sql
//  - Local embedded database: writes DATA_DIR/backups/lionheart-YYYY-MM-DD-HHMM.tar.gz
//    and keeps the 30 most recent. Also copy DATA_DIR/uploads (product photos).
const fs = require('fs');
const path = require('path');
const { db, initDb, DATA_DIR } = require('./db');

(async () => {
  if (db.kind !== 'pglite') {
    console.log('This site uses a hosted Postgres database (Supabase), which keeps its own daily backups.');
    console.log('For an extra copy run:  pg_dump "$DATABASE_URL" > lionheart-backup.sql');
    return;
  }
  await initDb();
  const dir = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const file = path.join(dir, `lionheart-${stamp}.tar.gz`);
  const blob = await db.driver.pglite.dumpDataDir('gzip');
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  const old = fs.readdirSync(dir).filter((f) => /^lionheart-.*\.tar\.gz$/.test(f)).sort().slice(0, -30);
  old.forEach((f) => fs.unlinkSync(path.join(dir, f)));
  console.log(`Backup written to ${file}`);
})()
  .catch((err) => {
    console.error('Backup failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
