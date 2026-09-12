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

// Doble proteccion: path secreto + header secret_token de Telegram
app.post(WEBHOOK_PATH, (req, res, next) => {
  if (req.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) {
    console.warn('[webhook] secreto invalido, rechazo update');
    return res.sendStatus(401);
  }
  next();
}, bot.webhookCallback(WEBHOOK_PATH));

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

start();
process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
