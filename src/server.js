// Servidor webhook (Render + local con ngrok). Sin polling: solo webhook.
require('dotenv').config();
const express = require('express');
const db = require('./db');
const { createBot } = require('./bot');

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const WEBHOOK_URL = (process.env.WEBHOOK_URL || '').trim().replace(/\/$/, ''); // ej: https://tu-app.onrender.com (local: https://xxx.ngrok-free.app)
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || '').trim();
const PORT = parseInt(process.env.PORT || '3000', 10);

if (!BOT_TOKEN) {
  console.error('[FATAL] Falta BOT_TOKEN en .env');
  process.exit(1);
}
if (!WEBHOOK_URL || !WEBHOOK_SECRET) {
  console.error('[FATAL] Faltan WEBHOOK_URL / WEBHOOK_SECRET en .env (ver .env.example)');
  process.exit(1);
}
if (WEBHOOK_SECRET.length < 16) {
  console.error('[FATAL] WEBHOOK_SECRET muy corto (min 16 caracteres aleatorios)');
  process.exit(1);
}

const WEBHOOK_PATH = `/webhook/${WEBHOOK_SECRET}`;
const bot = createBot(BOT_TOKEN);
const app = express();
app.use(express.json());

app.get('/', (_req, res) => res.json({ service: 'telegram-mirror-bot', mode: 'webhook' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'telegram-mirror-bot', ts: new Date().toISOString() }));

const BOOT_TS = Date.now();
// Diagnostico sin logs de Render: /diag?key=<WEBHOOK_SECRET> mide DB desde el servidor.
app.get('/diag', async (req, res) => {
  if (req.query.key !== WEBHOOK_SECRET) return res.sendStatus(401);
  const out = { uptime_s: Math.round((Date.now() - BOOT_TS) / 1000), version: '2b23bc7+' };
  try {
    let t0 = Date.now();
    await db.ping();
    out.db_ping_ms = Date.now() - t0;
    t0 = Date.now();
    const r = await db.getPool().query(
      'select (select count(*) from owners) as owners, (select count(*) from groups) as groups, (select count(*) from fanout_log) as logs'
    );
    out.db_counts_ms = Date.now() - t0;
    out.counts = r.rows[0];
    // Prueba Telegram API egress
    t0 = Date.now();
    await bot.telegram.getMe();
    out.tg_api_ms = Date.now() - t0;
    out.status = 'ok';
  } catch (e) {
    out.status = 'error';
    out.error = e.message;
  }
  res.json(out);
});

// Doble proteccion: path secreto + header secret_token de Telegram.
// ACK inmediato (200) y proceso en background: si el handler tarda
// (fan-out a 50, DB lenta...), Telegram no declara timeout ni reintenta.
app.post(WEBHOOK_PATH, (req, res) => {
  if (req.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) {
    console.warn('[webhook] secreto invalido, rechazo update');
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  const uid = req.body && req.body.update_id;
  console.log(`[webhook] update ${uid} ACK, procesando...`);
  bot.handleUpdate(req.body).catch((err) => {
    console.error(`[webhook] update ${uid} fallo:`, err?.response?.description || err.message);
  });
});

async function start() {
  await db.ping().catch((e) => {
    console.error('[FATAL] No conecto a Supabase (DATABASE_URL):', e.message);
    process.exit(1);
  });
  console.log('[OK] Supabase conectado');
  const fullUrl = WEBHOOK_URL + WEBHOOK_PATH;
  try {
    await bot.telegram.setWebhook(fullUrl, { secret_token: WEBHOOK_SECRET, drop_pending_updates: false });
    console.log('[OK] setWebhook:', fullUrl);
  } catch (e) {
    const desc = e?.response?.description || e.message;
    if (e?.response?.error_code === 401) {
      console.error('[FATAL] Token invalido (401). Revisa BOT_TOKEN.');
    } else {
      console.error('[FATAL] setWebhook fallo:', desc);
    }
    process.exit(1);
  }
  app.listen(PORT, () => console.log(`[OK] Escuchando en puerto ${PORT} (path ${WEBHOOK_PATH})`));
}

process.on('unhandledRejection', (e) => {
  console.error('[FATAL-ish] unhandledRejection:', e?.response?.description || e?.message || e);
});

start();
process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
