// Consistent online backup of the database (safe while the site is running).
//   npm run backup                      -> DATA_DIR/backups/lionheart-YYYY-MM-DD-HHMM.db
//   docker compose exec app npm run backup
// Keeps the 30 most recent backups. Also copy DATA_DIR/uploads (product photos).
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');

const dir = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const file = path.join(dir, `lionheart-${stamp}.db`);

db.backup(file)
  .then(() => {
    const old = fs.readdirSync(dir).filter((f) => /^lionheart-.*\.db$/.test(f)).sort().slice(0, -30);
    old.forEach((f) => fs.unlinkSync(path.join(dir, f)));
    console.log(`Backup written to ${file}`);
    db.close();
  })
  .catch((err) => {
    console.error('Backup failed:', err.message);
    process.exit(1);
  });
