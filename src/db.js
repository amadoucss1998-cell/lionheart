// Data layer: one async API over PostgreSQL.
//  - Production / Vercel: Supabase Postgres (DATABASE_URL, use the pooler connection string).
//  - Local development and tests: an embedded Postgres (PGlite) stored in DATA_DIR,
//    so the app runs with zero setup and uses exactly the same SQL.
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL;

if (!DATABASE_URL && process.env.VERCEL) {
  throw new Error(
    'DATABASE_URL is not set. On Vercel the app needs your Supabase database: copy the "Transaction pooler" ' +
      'connection string from Supabase (Project → Connect) into DATABASE_URL. See README → Deploying on Vercel.'
  );
}

// Queries are written with `?` (positional) or `@name` (named) placeholders and
// translated to Postgres `$1, $2…`. Quoted strings are left untouched.
function translate(sql, params) {
  const values = [];
  const named = params && !Array.isArray(params) ? params : null;
  const positional = Array.isArray(params) ? params : [];
  const indexOfName = new Map();
  let pos = 0;
  const text = sql.replace(/'(?:[^']|'')*'|\?|@([A-Za-z_]\w*)/g, (m, name) => {
    if (m.startsWith("'")) return m;
    if (m === '?') {
      values.push(clean(positional[pos++]));
      return `$${values.length}`;
    }
    if (!named || !(name in named)) throw new Error(`Missing SQL parameter @${name}`);
    if (!indexOfName.has(name)) {
      values.push(clean(named[name]));
      indexOfName.set(name, values.length);
    }
    return `$${indexOfName.get(name)}`;
  });
  return { text, values };
}

function clean(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

// ---- drivers ----

function pgDriver() {
  const pg = require('pg');
  pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // bigint (count) -> number
  pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric -> number
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
  const ssl =
    local || process.env.DATABASE_SSL === 'false'
      ? false
      : process.env.DATABASE_SSL_CA
        ? { ca: process.env.DATABASE_SSL_CA }
        : { rejectUnauthorized: false }; // Supabase pooler; set DATABASE_SSL_CA for strict verification
  const pool = new pg.Pool({
    connectionString: DATABASE_URL.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, ''),
    ssl,
    // Serverless functions each hold few connections; the Supabase pooler does the rest.
    max: Number(process.env.DATABASE_POOL_MAX) || (process.env.VERCEL ? 2 : 10),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
  const exec = (conn) => async (text, values) => {
    const r = await conn.query(text, values);
    return { rows: r.rows, count: r.rowCount };
  };
  return {
    kind: 'postgres',
    query: exec(pool),
    async transaction(fn) {
      const conn = await pool.connect();
      try {
        await conn.query('BEGIN');
        const result = await fn(exec(conn));
        await conn.query('COMMIT');
        return result;
      } catch (err) {
        await conn.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },
    close: () => pool.end(),
  };
}

function pgliteDriver() {
  const { PGlite } = require('@electric-sql/pglite');
  const dir = process.env.PGLITE_DIR || path.join(DATA_DIR, 'pgdata');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const pglite = new PGlite(dir);
  const exec = (conn) => async (text, values) => {
    const r = await conn.query(text, values);
    return { rows: r.rows, count: r.affectedRows ?? r.rows.length };
  };
  return {
    kind: 'pglite',
    dir,
    pglite,
    query: exec(pglite),
    transaction: (fn) => pglite.transaction((tx) => fn(exec(tx))),
    close: () => pglite.close(),
  };
}

const driver = DATABASE_URL ? pgDriver() : pgliteDriver();

function api(query) {
  return {
    async all(sql, params) {
      const { text, values } = translate(sql, params);
      return (await query(text, values)).rows;
    },
    async get(sql, params) {
      const { text, values } = translate(sql, params);
      return (await query(text, values)).rows[0];
    },
    async run(sql, params) {
      const { text, values } = translate(sql, params);
      return { changes: (await query(text, values)).count };
    },
    // INSERT … and return the new row's id.
    async insert(sql, params) {
      const { text, values } = translate(`${sql} RETURNING id`, params);
      return (await query(text, values)).rows[0].id;
    },
  };
}

const db = {
  ...api(driver.query),
  // Runs fn(tx) atomically; tx has the same all/get/run/insert methods.
  transaction: (fn) => driver.transaction((q) => fn(api(q))),
  close: () => driver.close(),
  kind: driver.kind,
  driver,
};

// Every table has row-level security enabled with no policies: Supabase's
// public REST API (anon / authenticated keys) can then read nothing, while
// the app's own database connection (table owner) works normally.
const TABLES = ['users', 'categories', 'suppliers', 'products', 'product_images', 'orders', 'order_items', 'order_events', 'sourcing_requests', 'notification_log', 'settings'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  company text,
  country text,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','staff','admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS categories (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  icon text,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS suppliers (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  contact_person text,
  phone text,
  email text,
  wechat text,
  city text,
  country text DEFAULT 'China',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  sku text UNIQUE,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  category_id integer REFERENCES categories(id) ON DELETE SET NULL,
  supplier_id integer REFERENCES suppliers(id) ON DELETE SET NULL,
  short_description text,
  description text,
  specs text,
  unit text NOT NULL DEFAULT 'piece',
  moq integer NOT NULL DEFAULT 1,
  sourcing_available integer NOT NULL DEFAULT 1,
  china_price double precision,
  china_lead_days integer,
  stock_available integer NOT NULL DEFAULT 0,
  stock_price double precision,
  stock_qty integer,
  stock_location text,
  featured integer NOT NULL DEFAULT 0,
  active integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

CREATE TABLE IF NOT EXISTS product_images (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  filename text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id);

CREATE TABLE IF NOT EXISTS orders (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  ref text NOT NULL UNIQUE,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  email text NOT NULL,
  phone text,
  company text,
  country text,
  city text,
  delivery_address text,
  shipping_method text,
  notes text,
  status text NOT NULL DEFAULT 'received',
  estimate_total double precision,
  goods_total double precision,
  shipping_cost double precision,
  other_charges double precision,
  quoted_total double precision,
  customer_message text,
  internal_notes text,
  tracking_number text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

CREATE TABLE IF NOT EXISTS order_items (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id integer REFERENCES products(id) ON DELETE SET NULL,
  product_name text NOT NULL,
  sku text,
  mode text NOT NULL CHECK (mode IN ('source','stock')),
  qty integer NOT NULL,
  unit text,
  unit_price double precision,
  notes text
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_events (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status text NOT NULL,
  message text,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);

CREATE TABLE IF NOT EXISTS sourcing_requests (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  ref text NOT NULL UNIQUE,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  country text,
  category_id integer REFERENCES categories(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity text,
  target_price text,
  image_filename text,
  status text NOT NULL DEFAULT 'new',
  admin_reply text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_log (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  channel text NOT NULL,
  recipient text,
  subject text,
  status text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value text
);

${TABLES.map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join('\n')}
`;

const DEFAULT_SETTINGS = {
  company_name: 'Lionheart Group of Companies',
  tagline: 'Source anything from China. Delivered to your door.',
  currency: 'USD',
  email: 'lionheartgroupinfo@gmail.com',
  phone: '+231888979704',
  whatsapp: '231888979704',
  address_liberia: 'Center and Carey Street, Monrovia, Liberia',
  address_china: 'Guangzhou, China',
  address_dubai: 'Dubai, United Arab Emirates',
  website: 'https://lionheartgroup.info',
  alert_emails: 'lionheartgroupinfo@gmail.com',
  alert_whatsapp_numbers: '231888979704',
  alert_on_requests: 'yes',
  payment_instructions:
    'Once you accept our quotation, we will send you an invoice with bank transfer details. ' +
    'Sourcing orders normally require a deposit before we purchase from the factory; the balance is due before shipping.',
};

// Creates tables and default settings. Safe to run on every start / cold start:
// an advisory lock stops two starting instances from migrating at the same time.
let initPromise;
function initDb() {
  if (!initPromise) {
    initPromise = db
      .transaction(async (tx) => {
        await tx.run('SELECT pg_advisory_xact_lock(727274)');
        for (const statement of SCHEMA.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
          await tx.run(statement);
        }
        for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
          await tx.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [k, v]);
        }
      })
      .catch((err) => {
        initPromise = null;
        throw err;
      });
  }
  return initPromise;
}

async function getSettings() {
  const rows = await db.all('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function setSetting(key, value) {
  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, value]);
}

module.exports = { db, initDb, getSettings, setSetting, DATA_DIR, DEFAULT_SETTINGS, SCHEMA, translate };
