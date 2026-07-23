# Custom Quote Calculator — Shopify Integration

A secure backend that connects a custom product quote calculator to Shopify, creating fully-priced, production-ready Draft Orders — including custom specifications and customer-uploaded artwork.

## What this does

1. Customer configures a custom product (material, size, quantity, finish) and optionally uploads artwork
2. The server calculates the price — **server-side, not trusting any price sent from the browser** — preventing price tampering
3. A Shopify Draft Order is created automatically, with the correct price and all custom specifications attached as line item properties
4. The customer receives a secure Shopify checkout link to complete payment
5. Production staff can view all order details — including a direct link to uploaded artwork — directly in Shopify Admin

## Architecture

```
Customer (Shopify storefront)
        │
        ▼
Calculator UI (embedded Shopify section or iframe)
        │
        ├── POST /api/upload  →  saves artwork, returns file URL
        │
        └── POST /api/quote   →  calculates price server-side
                                  creates Shopify Draft Order
                                  returns checkout link
```

## Tech stack

- **Node.js / Express** — backend server
- **Multer** — file upload handling
- **Shopify Admin API** (Draft Orders) — order creation
- **Render** — hosting

## Environment variables required

| Variable | Description |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | The store's `.myshopify.com` domain |
| `SHOPIFY_ADMIN_API_TOKEN` | Admin API access token (Draft Orders, Orders, Products scopes) |
| `PORT` | Set automatically by the hosting platform |

**Never commit the real `.env` file.** Use `.env.example` as a template; set real values directly in your hosting platform's environment variable settings.

## Required Shopify Admin API scopes

- `read_draft_orders`, `write_draft_orders`
- `read_orders`, `write_orders`
- `read_products`

## API Endpoints

### `POST /api/upload`
Uploads a single artwork file.
- **Body:** `multipart/form-data`, field name `artwork`
- **Returns:** `{ fileUrl, originalName, size }`

### `POST /api/quote`
Calculates pricing and creates a Shopify Draft Order.
- **Body:** JSON — `{ items: [ { material, width, height, quantity, finish, fileUrl } ] }`
- Supports multiple items in a single order; each is priced and tracked independently via a unique `quoteId`
- **Returns:** `{ items, draftOrder: { id, name, invoice_url, total_price } }`

## Local development

```bash
npm install
# create a .env file based on .env.example, with real values
node server.js
```

Server runs at `http://localhost:3000` by default.

## Deployment

Currently deployed on Render, connected to this GitHub repository. Any push to the `main` branch triggers an automatic redeploy.

**Note:** the free Render tier spins down after inactivity — the first request after idle time may take up to ~50 seconds to respond.

## Known limitations / recommended next steps for production

- **File storage:** uploaded files are currently stored on local disk, which is not persistent on Render's free/starter tiers across redeploys. For production use, migrate to cloud storage (e.g. AWS S3, Cloudinary).
- **CORS:** currently open to all origins for development convenience. Before going live, restrict this to the client's actual storefront domain.
- **Pricing logic:** current material rates and finishing surcharges are placeholder values for testing. Replace with the client's real pricing formulas before launch.
- **Calculator UI:** the included `calculator.html` is a functional testing prototype. For production, this should be rebuilt as either a native Shopify theme section or embedded via iframe into the storefront.

## Support

[Add your contact details / support terms here before handing off to a client]
