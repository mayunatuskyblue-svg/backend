
# BeautyLanka Stripe Backend (Webhook + Admin)

A minimal Node.js + Express + SQLite backend to support Stripe Checkout + webhook reconciliation, plus a tiny admin UI.

## Quick Start

```bash
cp .env.example .env
# Edit STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, ADMIN_TOKEN
npm i
npm run dev
# -> http://localhost:8787
```

### Stripe Webhook
```
stripe listen --forward-to localhost:8787/webhook/stripe
```
Copy the `whsec_...` into `.env` as `STRIPE_WEBHOOK_SECRET`.

### Admin UI
Open `http://localhost:8787/admin` and enter `ADMIN_TOKEN`.

### API
- POST /api/reservations
- POST /api/create-checkout
- POST /webhook/stripe (Stripe calls this)
- GET /api/reservations (admin)
- PATCH /api/reservations/:id (admin)
