# Lionheart Trade Portal

Product catalog and ordering system for **Lionheart Group of Companies**. Customers browse products you have suppliers for and order them in one of two ways:

- **Source from China:** factory price and minimum order. Lionheart buys from the supplier, inspects the goods and ships them.
- **Buy from Lionheart stock:** goods already in your Dubai (or other) warehouse, with no factory minimum.

Categories come pre-loaded: Electronics, Machinery, Heavy Equipment, Vehicles, Furniture, Building Materials, Tiles & Ceramics, Sanitary Ware, Roofing (Decra & Zinc), Doors & Windows, and Electrical & Solar. You can add or rename categories in the admin panel.

## How ordering works

1. The customer adds products to the cart and picks *China sourcing* or *our stock* for each line.
2. At checkout they give contact and delivery details and a preferred shipping method (FCL, LCL, air, RoRo or pickup). **No payment is taken online.**
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

## Front end

- The home page hero shows an interactive **Three.js** globe. Gold trade lanes run from China to Dubai and West Africa, with cargo moving along them and a mouse parallax effect.
- **GSAP + ScrollTrigger** handle the entrance animations, scroll reveals, count-up numbers, 3D card tilt and magnetic buttons.
- Both libraries are served from `node_modules`, so no external CDN is needed.
- Animations are turned off for visitors with *reduced motion* enabled. Without WebGL the globe falls back to the static gradient.
- The layout is responsive and mobile-first. A WhatsApp button appears on every page.

## Running it

Requires **Node.js 22+**.

```bash
npm install
ADMIN_EMAIL=you@yourcompany.com ADMIN_PASSWORD='a-strong-password' SESSION_SECRET='long-random-string' npm start
# open http://localhost:3000, admin at http://localhost:3000/admin
```

On first start, the system creates the admin account. If `ADMIN_PASSWORD` is not set, it generates a random password and prints it to the console once. It also loads **sample products** so the catalog isn't empty. Their prices are only illustrative, so edit or delete them before going live. Set `SEED_DEMO=false` to start with an empty catalog.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `SESSION_SECRET` | random per start | Signs login cookies. **Set this in production**, or everyone is logged out on each restart. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@lionheartgroup.info` / generated | First admin account |
| `DATA_DIR` | `./data` | SQLite database and uploaded photos. **Back this folder up.** |
| `COOKIE_SECURE` | `false` | Set to `true` when served over HTTPS |
| `SEED_DEMO` | `true` | Load sample categories and products on first start |

Run the tests with `npm test`.

## Tech

Node.js, Express 5, EJS server-rendered pages, SQLite (better-sqlite3), Three.js and GSAP. Every form is protected with CSRF tokens. Passwords are hashed with bcrypt. Uploads are limited to images of 8 MB or less.

## Deploying

The app is a single Node process with a local SQLite file. It runs on any VPS (for example a small DigitalOcean, Hetzner or AWS Lightsail server) behind Nginx or Caddy for HTTPS. It also works on platforms with a persistent disk, such as Render or Railway. Point `DATA_DIR` at the persistent disk.
