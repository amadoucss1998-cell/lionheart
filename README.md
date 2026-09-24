# Lionheart Trade Portal

Product catalog and ordering system for **Lionheart Group of Companies**. Customers browse products you have suppliers for and order them in one of two ways:

- **Source from China:** factory price and minimum order. Lionheart buys from the supplier, inspects the goods and ships them.
- **Buy from Lionheart stock:** goods already in your Dubai (or other) warehouse, with no factory minimum.

Categories come pre-loaded: Electronics, Machinery, Heavy Equipment, Vehicles, Furniture, Building Materials, Tiles & Ceramics, Sanitary Ware, Roofing (Decra & Zinc), Doors & Windows, and Electrical & Solar. You can add or rename categories in the admin panel.

## How ordering works

1. The customer adds products to the cart and picks *China sourcing* or *our stock* for each line.
2. At checkout they give contact and delivery details and a preferred shipping method (FCL, LCL, air, RoRo or pickup). **No payment is taken online.** Your team gets an email and/or WhatsApp alert straight away.
3. Your team opens the order in the admin panel, enters the final unit prices, shipping and other charges, and clicks **Send quotation**.
4. The customer sees the quotation on their order page and clicks **Accept**. The payment instructions (set in Settings) are then shown.
5. Staff move the order through its stages: *Payment confirmed → Purchasing → Quality inspection → Shipped → Arrived / customs → Delivered*. They can add a container or B/L number and a message at each step. The customer sees a live progress bar and history.

Customers can check out as a guest, or create an account to see all their orders. Guests can look up an order with the order number and email at `/track`. If a customer can't find a product, they send a **sourcing request** with a description and photo from `/request`.

## Admin panel (`/admin`)

- **Products:** add and edit products with several photos, a specs table, China price / MOQ / lead time, and stock price / quantity / location. You can also mark products featured, hide them, or duplicate them.
- **Bulk import:** upload a CSV, for example a supplier price list. A template is provided. Rows whose SKU already exists update that product.
- **Suppliers:** a private list of factories and partners (contact, WeChat, city, notes), linked to products. Customers never see it. Staff see the supplier next to each order line.
- **Orders:** filter by status, build quotations, update status and tracking numbers, keep internal notes, open WhatsApp or email to the customer, and export to CSV.
- **Sourcing requests:** reply to custom requests. The reply appears in the customer's account.
- **Customers & team:** add staff or admin users.
- **Settings:** company contacts, WhatsApp number, currency and payment instructions.

## New order alerts (email & WhatsApp)

When a customer places an order or sends a sourcing request, your team gets an alert right away. It includes the customer's name, phone, destination, shipping method, the items and quantities, the estimated value, and a link that opens the order in the admin panel.

- **Who receives alerts** is set by an admin under **Admin → Settings → New order alerts**. Add one or more emails and WhatsApp numbers. You can also turn sourcing-request alerts off there, and send a **test alert**.
- **Delivery log:** the same page shows every alert sent, and why it failed if it did (wrong password, expired token and so on).
- **Alerts never slow down or break checkout.** If an alert fails, the order is still saved and the failure is logged.
- **Passwords and API keys** are set as environment variables on the server, never in the admin panel. Restart the server after changing them.
- **Set `PUBLIC_URL`** (for example `https://shop.lionheartgroup.info`) so the links in alerts point to your real domain.

### Email

Any SMTP account works. For Gmail:

1. Turn on 2-step verification for the Google account.
2. Create an **App password** at <https://myaccount.google.com/apppasswords>.
3. Set these variables:

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=lionheartgroupinfo@gmail.com
SMTP_PASS='the 16-character app password'
MAIL_FROM='Lionheart Alerts <lionheartgroupinfo@gmail.com>'
```

### WhatsApp: choose one provider

**Option A: CallMeBot.** Free and quickest to set up, good for alerts to your own phones.
1. On each phone that should receive alerts, add **+34 644 51 95 23** to your contacts and send it the WhatsApp message `I allow callmebot to send me messages`.
2. It replies with an API key. Then set:
```bash
WHATSAPP_PROVIDER=callmebot
CALLMEBOT_RECIPIENTS='231888979704:APIKEY1,971500000000:APIKEY2'   # phone:apikey pairs
```
CallMeBot is a free third-party service with no delivery guarantee. For business-critical use, choose B or C.

**Option B: Meta WhatsApp Cloud API.** The official option, sent from your company's WhatsApp Business number.
1. Create an app at <https://developers.facebook.com>, add the **WhatsApp** product and a business phone number, and create a **permanent access token** (System User).
2. WhatsApp only delivers messages a business starts if they use an approved **message template**. Create a *Utility* template, for example `new_order_alert`, with this body:
   `New order {{1}} from {{2}}, {{3}}. Items: {{4}}. Estimated value: {{5}}. Open: {{6}}`
3. Set these variables:
```bash
WHATSAPP_PROVIDER=cloud
WHATSAPP_TOKEN='permanent access token'
WHATSAPP_PHONE_NUMBER_ID='123456789012345'
WHATSAPP_TEMPLATE=new_order_alert
WHATSAPP_TEMPLATE_LANG=en
```
The recipients are the WhatsApp numbers entered in Settings.

**Option C: Twilio.** Uses the same template variables {{1}} to {{6}} as option B.
```bash
WHATSAPP_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_WHATSAPP_FROM=14155238886          # your Twilio WhatsApp sender
TWILIO_CONTENT_SID=HXxxxxxxxx             # approved template (recommended)
```

## Front end

- The home page hero shows an interactive **Three.js** globe. Gold trade lanes run from China to Dubai and West Africa, with cargo moving along them and a mouse parallax effect.
- **GSAP + ScrollTrigger** handle the entrance animations, scroll reveals, count-up numbers, 3D card tilt and magnetic buttons.
- Both libraries are served from `node_modules`, so no external CDN is needed.
- Animations are turned off for visitors with *reduced motion* enabled. Without WebGL the globe falls back to the static gradient.
- The layout is responsive and mobile-first. A WhatsApp button appears on every page.

## Running it on your computer

Requires **Node.js 22+**.

```bash
npm install
npm start          # http://localhost:3000, admin at /admin
```

On first start, the system creates the admin account. If `ADMIN_PASSWORD` is not set, it generates a random password and prints it in the terminal once. It also loads **sample products** so the catalog isn't empty. Their prices are only illustrative, so replace them before going live. Set `SEED_DEMO=false` to start with an empty catalog.

## Deploying

The site is one Node.js app with a SQLite database file. **Everything it stores lives in one folder, `/data`**: the database and uploaded photos. Keep that folder on a persistent disk and back it up.

### Option 1: Your own server (VPS) with Docker. Recommended.

A small server is enough: 1 CPU and 1–2 GB RAM, for example DigitalOcean, Hetzner, AWS Lightsail or Contabo, running Ubuntu 22.04 or 24.04. HTTPS is automatic through Caddy.

1. **Point your domain at the server.** In your DNS, create an `A` record, for example `shop.lionheartgroup.info`, pointing to the server's IP address. Optionally add `www.shop…` too.
2. **Install Docker** on the server: `curl -fsSL https://get.docker.com | sh`
3. **Get the code and configure it:**
   ```bash
   git clone https://github.com/amadoucss1998-cell/lionheart.git && cd lionheart
   cp .env.example .env
   nano .env        # set DOMAIN, SESSION_SECRET (openssl rand -hex 32), ADMIN_PASSWORD, alerts
   ```
4. **Start it:** `docker compose up -d --build`
5. Open `https://your-domain` and sign in at `/admin` with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

Day-to-day commands:

```bash
docker compose logs -f app                 # view logs
git pull && docker compose up -d --build   # update to the latest version
docker compose exec app npm run backup     # back up the database now
```

**Nightly backups.** Add this line to the server's crontab (`crontab -e`). It keeps the last 30 backups inside the data volume:
`0 2 * * * cd /root/lionheart && docker compose exec -T app npm run backup`.
Also copy them off the server now and then, together with the uploaded photos:
`docker compose cp app:/data ./lionheart-data-copy`.

### Option 2: Render (managed, no server to maintain)

1. Push this repository to GitHub. It's already there.
2. On <https://render.com>, choose **New → Blueprint** and select the repository. `render.yaml` creates the web service with a 5 GB persistent disk and a generated `SESSION_SECRET`.
3. Fill in `PUBLIC_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` and the alert settings when asked. Then add your domain under **Settings → Custom Domains**.

A persistent disk needs a paid plan (Starter). Railway and Fly.io also work with the included `Dockerfile`, as long as you attach a volume at `/data`.

### Option 3: Without Docker

On a server with Node.js 22+: `npm ci --omit=dev`, create `.env` from `.env.example`, run `NODE_ENV=production npm start`, and put Nginx or Caddy in front for HTTPS. The app reads `.env` automatically. Use a process manager (systemd or pm2) so it restarts after reboots.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `SESSION_SECRET` | random per start | Signs login cookies. **Required in production.** |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@lionheartgroup.info` / generated | First admin account |
| `DATA_DIR` | `./data` | SQLite database and uploaded photos. **Back this folder up.** |
| `SEED_DEMO` | `true` | Load sample categories and products on first start |
| `PUBLIC_URL` | from request | Your site's address, used for links in alerts |
| `SMTP_*`, `MAIL_FROM`, `WHATSAPP_*`, `TWILIO_*`, `CALLMEBOT_RECIPIENTS` | unset | Alert channels (see above) |
| `NODE_ENV` | `development` | Set to `production` on the live server. It refuses to start without `SESSION_SECRET`. |
| `COOKIE_SECURE` | `true` if `PUBLIC_URL` is https | Force secure cookies on or off |
| `RATE_LIMIT` | on | Set to `off` to disable the sign-in and form limits (not recommended) |

### Go-live checklist

- [ ] `DOMAIN` / `PUBLIC_URL` point to your real domain and HTTPS works
- [ ] `SESSION_SECRET` is a long random value and `ADMIN_PASSWORD` is strong. Change the password again after the first sign-in (**My profile**).
- [ ] Sample products are deleted or replaced with real ones and real prices
- [ ] **Settings:** China and Dubai addresses, phone, WhatsApp number, currency and payment instructions are correct
- [ ] Email and/or WhatsApp alerts are set up, and **Send a test alert** arrives
- [ ] Place one test order from a phone, quote it in the admin, accept it, then cancel it
- [ ] Nightly backups are scheduled
- [ ] Team members have their own staff accounts (**Customers & team**)

## Testing

```bash
npm test          # 18 server tests: ordering, quotations, security, alerts, uploads, CSV import
npm run test:e2e  # real-browser test (Chromium) of a running site
```

`test:e2e` works against a local or live site. It checks the 3D home page, runs a customer order (China sourcing and stock), then admin quotation → customer acceptance → shipping update. It also uploads a product with a photo and checks the pages fit on a phone screen. Before the first run, do `npx playwright install chromium`:

```bash
BASE_URL=https://shop.lionheartgroup.info ADMIN_EMAIL=… ADMIN_PASSWORD=… npm run test:e2e
```

It places one order named "E2E Test" and cancels it at the end, and deletes the test product it creates.

GitHub Actions (`.github/workflows/ci.yml`) runs on every push. It runs the server tests, builds the Docker image, starts it, checks `/healthz`, and runs the browser test against the container.

## Tech

Node.js, Express 5, EJS server-rendered pages, SQLite (better-sqlite3), Three.js and GSAP. Every form is protected with CSRF tokens. Passwords are hashed with bcrypt. Uploads are limited to images of 8 MB or less. Rate limiting protects sign-in and public forms. A strict Content-Security-Policy and HSTS are sent, and `/healthz` supports uptime monitoring.
