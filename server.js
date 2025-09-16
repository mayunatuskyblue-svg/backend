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
app.use('/admin', express.static(path.join(__dirname, 'public')));
// 例: 直下に admin.html があるなら次の1行でもOK
// app.get('/admin', (_req, res)=> res.sendFile(path.join(__dirname, 'admin.html')));

/* ─────────────────────────────────────────
   Start
────────────────────────────────────────── */
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
