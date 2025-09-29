// server.js (ESM統一・Webhook重複解消版)
import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import helmet from 'helmet';
import morgan from 'morgan';
import cors from 'cors';
import Stripe from 'stripe';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Database } from './sqlite.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/* ─────────────────────────────────────────
   Stripe setup
────────────────────────────────────────── */
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;

/* ─────────────────────────────────────────
   DB setup（Webhookからも使うため先に初期化）
────────────────────────────────────────── */
const dbPath = path.join(__dirname, 'data');
if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath, { recursive: true });
const db = new Database(path.join(dbPath, 'app.db'));
db.migrate();

/* ─────────────────────────────────────────
   Middleware（セキュリティ・ログ）
────────────────────────────────────────── */
app.use(helmet());
app.use(cors({ origin: true, credentials: false }));
app.use(morgan('dev'));

/* ─────────────────────────────────────────
   Webhook（必ず json パーサより前・rawで受ける）
   ※ ここを唯一のWebhookにする（/webhook/stripe）
────────────────────────────────────────── */
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(500).send('Stripe not configured');

  let event = req.body; // raw Buffer
  if (STRIPE_WEBHOOK_SECRET) {
    const sig = req.headers['stripe-signature'];
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    // 開発用途：署名検証を省略（本番は必ず STRIPE_WEBHOOK_SECRET を設定）
    try {
      event = JSON.parse(req.body);
    } catch {
      // noop: event はそのまま（stripe listen 利用時は constructEvent が必要）
    }
  }

  // 必要イベントのみ処理
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const reservationId =
        session.client_reference_id ||
        (session.metadata && session.metadata.reservation_id);
      if (reservationId) {
        try {
          db.updateReservationStatus(reservationId, 'paid');
          db.attachPaymentIntent(reservationId, session.payment_intent || '');
        } catch (e) {
          console.error('DB update error in webhook:', e);
        }
      }
      break;
    }
    case 'setup_intent.succeeded': {
      const si = event.data.object;
      console.log('Setup succeeded:', si.id, si.payment_method);
      // 例：si.metadata.bookingId を使って BOOKING_TO_STRIPE を更新するならここで対応
      break;
    }
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      console.log('Payment succeeded:', pi.id);
      break;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      console.log('Payment failed:', pi.id, pi.last_payment_error?.message);
      break;
    }
  }

  res.json({ received: true });
});

/* ─────────────────────────────────────────
   通常のパーサ（Webhookの後に置く）※1回だけ
────────────────────────────────────────── */
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/* ─────────────────────────────────────────
   管理系（トークン保護）
────────────────────────────────────────── */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  const token = auth.slice(7);
  if (token !== ADMIN_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  next();
}

/* ─────────────────────────────────────────
   ヘルスチェック
────────────────────────────────────────── */
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ─────────────────────────────────────────
   予約API（例）
────────────────────────────────────────── */
app.post('/api/reservations', (req, res) => {
  const {
    salonId, salonName, item, price, timeISO,
    contact = {}, status = 'pending'
  } = req.body || {};

  if (!salonId || !item) return res.status(400).json({ error: 'Missing required fields' });
  const id = db.createReservation({
    salon_id: String(salonId),
    salon_name: String(salonName || ''),
    item: String(item),
    price: Number(price || 0),
    time_iso: String(timeISO || ''),
    contact_name: String(contact.name || ''),
    contact_email: String(contact.email || ''),
    contact_phone: String(contact.phone || ''),
    status: String(status)
  });
  return res.json({ id });
});

app.get('/api/reservations/:id', (req, res) => {
  const row = db.getReservation(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  return res.json(row);
});

app.get('/api/reservations', requireAdmin, (req, res) => {
  const { status, q, limit = 200, offset = 0 } = req.query;
  const rows = db.listReservations({
    status,
    q,
    limit: Number(limit),
    offset: Number(offset)
  });
  res.json(rows);
});

app.patch('/api/reservations/:id', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'status required' });
  const ok = db.updateReservationStatus(req.params.id, status);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  return res.json({ ok: true });
});

/* ─────────────────────────────────────────
   SmartPay Admin 用 追加API
   - 簡易ログイン(A案)
   - サロン別カタログ
   - 保存済みカードへの課金
────────────────────────────────────────── */

// A) サロン定義（最初はハードコード。あとでDB/Sheetに移行可）
const SALONS = {
  "salon01": { name: "Beauty Lanka Colombo", password: "abc123", taxRate: 18, serviceRate: 10 },
  "salon02": { name: "Spa Paradise Kandy",   password: "xyz789", taxRate: 15, serviceRate: 12 }
};

// B) サロン別カタログ
const CATALOGS = {
  "salon01": {
    menus: [
      { id: "M_BASIC", name: "Basic Treatment", price: 5000 },
      { id: "M_PREMIUM", name: "Premium Treatment", price: 9000 }
    ],
    addons: [
      { id: "A_EXT30", name: "Extend 30 min", price: 2000 },
      { id: "A_AROMA", name: "Aroma Oil",     price: 1500 }
    ],
    discounts: [
      { id: "D_10P", type: "percent", value: 10, name: "10% OFF" },
      { id: "D_500", type: "flat",    value: 500, name: "LKR 500 OFF" }
    ],
  },
  "salon02": {
    menus: [
      { id: "M_STD", name: "Standard Spa", price: 7000 },
      { id: "M_LUX", name: "Luxury Spa",   price: 12000 }
    ],
    addons: [
      { id: "A_SCRUB", name: "Body Scrub", price: 2500 },
      { id: "A_MASK",  name: "Herb Mask",  price: 1800 }
    ],
    discounts: [
      { id: "D_5P", type: "percent", value: 5, name: "5% OFF" },
      { id: "D_800", type: "flat",   value: 800, name: "LKR 800 OFF" }
    ],
  }
};

// C) 予約(bookingId) → Stripe 顧客/保存PM（初期は手動で）
const BOOKING_TO_STRIPE = {
  "BOOK_001": { stripeCustomerId: "cus_XXXXXXXXXXXX", defaultPaymentMethod: "pm_XXXXXXXXXXXX" }
};

// 1) 簡易ログイン
app.post("/api/auth/login", (req, res) => {
  const { salonId, password } = req.body || {};
  const s = SALONS[salonId];
  if (!s || s.password !== String(password || "")) {
    return res.status(401).json({ ok:false, error:"invalid credentials" });
  }
  return res.json({ ok:true, salon: { id: salonId, name: s.name } });
});

// 2) サロン別カタログ取得
app.get("/api/catalog", (req, res) => {
  const salonId = String(req.query.salonId || "");
  const s = SALONS[salonId];
  if (!s) return res.status(404).json({ error: "unknown salonId" });
  const cat = CATALOGS[salonId] || { menus:[], addons:[], discounts:[] };
  res.json({ ...cat, taxRate: s.taxRate, serviceRate: s.serviceRate });
});

// 3) 課金（保存済みカードに off_session で確定）
app.post("/api/charge", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok:false, error:"Stripe not configured" });

    const { salonId, bookingId, amountLKR, approvalId } = req.body || {};
    if (!salonId || !bookingId || !amountLKR) {
      return res.status(400).json({ ok:false, error:"missing fields" });
    }

    const link = BOOKING_TO_STRIPE[String(bookingId)];
    if (!link || !link.stripeCustomerId || !link.defaultPaymentMethod) {
      return res.status(400).json({ ok:false, error:"customer has no saved card" });
    }

    const amount = Math.round(Number(amountLKR)); // LKRは整数単位
    const pi = await stripe.paymentIntents.create({
      amount,
      currency: "lkr",
      customer: link.stripeCustomerId,
      payment_method: link.defaultPaymentMethod,
      confirm: true,
      off_session: true,
      description: `SmartPay charge for booking ${bookingId} (${salonId})`,
      // metadata: { approvalId }
    });

    res.json({ ok:true, paymentIntentId: pi.id, status: pi.status });
  } catch (e) {
    console.error("charge error:", e);
    res.status(400).json({ ok:false, error: e.message, code: e.code, pi: e.payment_intent?.id });
  }
});

/* ─────────────────────────────────────────
   Checkout（例：既存機能）
────────────────────────────────────────── */
app.post('/api/create-checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const {
      reservationId, item, price,
      currency = 'usd',
      successBaseUrl, cancelBaseUrl
    } = req.body || {};

    if (!reservationId || !item) {
      return res.status(400).json({ error: 'reservationId and item required' });
    }

    const nPrice = Number(price || 0);
    const unit_amount =
      String(currency).toLowerCase() === 'jpy'
        ? Math.round(nPrice)
        : Math.round(nPrice * 100);

    const base = successBaseUrl || `${req.protocol}://${req.get('host')}`;
    const success_url = `${base}/thankyou.html?reservationId=${encodeURIComponent(reservationId)}`;
    const cancel_url  = `${cancelBaseUrl || base}/confirm.html?reservationId=${encodeURIComponent(reservationId)}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: { currency, product_data: { name: item }, unit_amount },
        quantity: 1
      }],
      success_url,
      cancel_url,
      client_reference_id: String(reservationId),
      metadata: { reservation_id: String(reservationId), item: String(item) }
    });

    db.attachStripeSession(reservationId, session.id);
    return res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create checkout' });
  }
});

/* ─────────────────────────────────────────
   Admin UI 静的配信（public/admin.html を配信）
────────────────────────────────────────── */
app.use('/admin', express.static(path.join(__dirname, 'public'), { index: 'admin.html' }));
// 直下に admin.html がある場合はこちらでもOK
// app.get('/admin', (_req, res)=> res.sendFile(path.join(__dirname, 'admin.html')));

/* ─────────────────────────────────────────
   Start
────────────────────────────────────────── */
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
