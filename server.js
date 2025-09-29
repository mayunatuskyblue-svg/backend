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
   Stripe setup（最初にまとめる）
────────────────────────────────────────── */
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;

/* ─────────────────────────────────────────
   Middleware（セキュリティ・ログ）
────────────────────────────────────────── */
app.use(helmet());
app.use(cors({ origin: true, credentials: false }));
app.use(morgan('dev'));

/* ─────────────────────────────────────────
   Webhook（必ず json パーサより前・rawで受ける）
────────────────────────────────────────── */
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(500).send('Stripe not configured');
  let event = req.body; // raw のまま

  if (STRIPE_WEBHOOK_SECRET) {
    const sig = req.headers['stripe-signature'];
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }

  // 必要イベントのみ処理
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const reservationId =
      session.client_reference_id ||
      (session.metadata && session.metadata.reservation_id);

    if (reservationId) {
      db.updateReservationStatus(reservationId, 'paid');
      db.attachPaymentIntent(reservationId, session.payment_intent || '');
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
   DB setup
────────────────────────────────────────── */
const dbPath = path.join(__dirname, 'data');
if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath, { recursive: true });
const db = new Database(path.join(dbPath, 'app.db'));
db.migrate();

/* ─────────────────────────────────────────
   管理系
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
   予約API
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
   Stripe Checkout セッション作成
   ※ JPY は最小通貨単位が 0 桁
────────────────────────────────────────── */
app.post('/api/create-checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const {
      reservationId,
      item,
      price,
      currency = 'usd',
      successBaseUrl,
      cancelBaseUrl
    } = req.body || {};

    if (!reservationId || !item) {
      return res.status(400).json({ error: 'reservationId and item required' });
    }

    const nPrice = Number(price || 0);
    const unit_amount =
      String(currency).toLowerCase() === 'jpy'
        ? Math.round(nPrice)             // JPY: そのまま整数円
        : Math.round(nPrice * 100);      // USD/LKR: セント

    const base = successBaseUrl || `${req.protocol}://${req.get('host')}`;
    const success_url = `${base}/thankyou.html?reservationId=${encodeURIComponent(reservationId)}`;
    const cancel_url  = `${cancelBaseUrl || base}/confirm.html?reservationId=${encodeURIComponent(reservationId)}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency,
          product_data: { name: item },
          unit_amount,
        },
        quantity: 1
      }],
      success_url,
      cancel_url,
      client_reference_id: String(reservationId),
      metadata: {
        reservation_id: String(reservationId),
        item: String(item)
      }
    });

    db.attachStripeSession(reservationId, session.id);
    return res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create checkout' });
  }
});

/* ─────────────────────────────────────────
   Admin UI 静的配信（admin.html を public 配下に置いた場合）
   ※ もし admin.html がプロジェクト直下なら下の行を調整
────────────────────────────────────────── */
// Admin UI
app.use(
  '/admin',
  express.static(
    path.join(__dirname, 'public'),
    { index: 'admin.html' }   // 👈 これを追加
  )
);


// 例: 直下に admin.html があるなら次の1行でもOK
// app.get('/admin', (_req, res)=> res.sendFile(path.join(__dirname, 'admin.html')));

/* ─────────────────────────────────────────
   Start
────────────────────────────────────────── */
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

// C) 予約(bookingId) → Stripe 顧客/支払い手段 のひも付け（初期は手動で）
const BOOKING_TO_STRIPE = {
  // 例）予約 BOOK_001 は、保存済みカードを持つ Stripe 顧客に紐付いている
  // 顧客ID: cus_xxx、保存済みPM: pm_xxx（SetupIntent で事前に保存しておく）
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

    // 予約→Stripe顧客/PM の取得
    const link = BOOKING_TO_STRIPE[String(bookingId)];
    if (!link || !link.stripeCustomerId || !link.defaultPaymentMethod) {
      return res.status(400).json({ ok:false, error:"customer has no saved card" });
    }

    const amount = Math.round(Number(amountLKR)); // LKRは整数
    const pi = await stripe.paymentIntents.create({
      amount,
      currency: "lkr",
      customer: link.stripeCustomerId,
      payment_method: link.defaultPaymentMethod,
      confirm: true,
      off_session: true,
      description: `SmartPay charge for booking ${bookingId} (${salonId})`,
      // metadata: { approvalId } // 追跡したいなら
    });

    res.json({ ok:true, paymentIntentId: pi.id, status: pi.status });
  } catch (e) {
    console.error("charge error:", e);
    res.status(400).json({ ok:false, error: e.message, code: e.code, pi: e.payment_intent?.id });
  }
});
/* === 保存カード 登録フロー (SetupIntent) ======================= */
/*
  使い方（簡易）：
  1) /api/customer/upsert で顧客(bookingId)⇔stripeCustomer をひも付け
  2) /api/setup/start で SetupIntent を作成 → client_secret をフロントへ返す
  3) フロントで Stripe.js を使い、confirmCardSetup() でカード入力＆保存
*/

const { v4: uuidv4 } = require("uuid");

// 既存: BOOKING_TO_STRIPE を使っているので、ここに保存していく（初期はメモリ保持）
function upsertBookingLink(bookingId, stripeCustomerId, defaultPaymentMethod) {
  BOOKING_TO_STRIPE[bookingId] = { stripeCustomerId, defaultPaymentMethod: defaultPaymentMethod || null };
  return BOOKING_TO_STRIPE[bookingId];
}

// 1) 顧客作成/取得（bookingIdとメール・名前などでひも付け）
app.post("/api/customer/upsert", async (req, res) => {
  try {
    const { bookingId, email, name } = req.body || {};
    if (!bookingId) return res.status(400).json({ ok:false, error:"bookingId required" });
    if (!stripe) return res.status(500).json({ ok:false, error:"Stripe not configured" });

    // 既にリンクがあればそのまま返す
    const existed = BOOKING_TO_STRIPE[bookingId];
    if (existed?.stripeCustomerId) {
      const cus = await stripe.customers.retrieve(existed.stripeCustomerId);
      return res.json({ ok:true, customerId: cus.id });
    }

    // 新規 Customer
    const cus = await stripe.customers.create({
      email: email || undefined,
      name: name || undefined,
      metadata: { bookingId }
    });

    upsertBookingLink(bookingId, cus.id, null);
    return res.json({ ok:true, customerId: cus.id });
  } catch(e) {
    console.error(e);
    res.status(400).json({ ok:false, error:e.message });
  }
});

// 2) SetupIntent を開始（client_secret を返す）
app.post("/api/setup/start", async (req, res) => {
  try {
    const { bookingId } = req.body || {};
    if (!bookingId) return res.status(400).json({ ok:false, error:"bookingId required" });
    if (!stripe) return res.status(500).json({ ok:false, error:"Stripe not configured" });

    const link = BOOKING_TO_STRIPE[bookingId];
    if (!link?.stripeCustomerId) return res.status(400).json({ ok:false, error:"customer not linked" });

    const si = await stripe.setupIntents.create({
      customer: link.stripeCustomerId,
      usage: "off_session",
      payment_method_types: ["card"],
      metadata: { bookingId }
    });

    res.json({ ok:true, client_secret: si.client_secret, setupIntentId: si.id });
  } catch(e) {
    console.error(e);
    res.status(400).json({ ok:false, error:e.message });
  }
});

// 3) Webhook で「保存完了」や「支払い完了」を最終確定（下のステップ3で本体を作る）

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
