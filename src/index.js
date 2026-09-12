// Bot espejo por cita + comando. Gratis con Bot API.
// Flujo: admin cita un mensaje en el grupo origen y manda:
//   /enviar                  -> copia a TODOS los destinos
//   /enviar_a <uno>          -> copia a 1 destino (alias, ID o numero de /grupos)
//   /enviar_varios <lista>   -> copia a varios (separados por coma o espacio)
// Helpers: /grupos (lista destinos), /id (ver IDs), /help
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const SOURCE_GROUP_ID = String(process.env.SOURCE_GROUP_ID || '').trim();
const SEND_DELAY_MS = Math.max(0, parseInt(process.env.SEND_DELAY_MS || '80', 10) || 0);
const ADMIN_CACHE_TTL = Math.max(30, parseInt(process.env.ADMIN_CACHE_TTL || '300', 10) || 300);

if (!BOT_TOKEN) {
  console.error('[FATAL] Falta BOT_TOKEN en .env (copia .env.example a .env)');
  process.exit(1);
}
if (!SOURCE_GROUP_ID) {
  console.error('[FATAL] Falta SOURCE_GROUP_ID en .env');
  process.exit(1);
}

// ---- Carga destinos ----
const targetsPath = path.join(__dirname, '..', 'targets.json');
let TARGETS = [];
try {
  const raw = fs.readFileSync(targetsPath, 'utf8');
  TARGETS = JSON.parse(raw);
  if (!Array.isArray(TARGETS)) throw new Error('targets.json debe ser un array');
} catch (e) {
  if (e.code === 'ENOENT') {
    console.error('[FATAL] No existe targets.json (copia targets.json.example a targets.json y carga tus 50 destinos)');
  } else {
    console.error('[FATAL] targets.json invalido:', e.message);
  }
  process.exit(1);
}
TARGETS = TARGETS
  .filter((t) => t && typeof t.id !== 'undefined' && t.alias)
  .map((t, i) => ({
    alias: String(t.alias).trim().toLowerCase(),
    id: Number(t.id),
    type: t.type || 'group',
    name: t.name || String(t.alias),
    index: i + 1, // numero visible en /grupos
  }));

if (TARGETS.length === 0) {
  console.error('[FATAL] targets.json no tiene destinos validos');
  process.exit(1);
}

const byAlias = new Map(TARGETS.map((t) => [t.alias, t]));
const byId = new Map(TARGETS.map((t) => [String(t.id), t]));
const byIndex = new Map(TARGETS.map((t) => [String(t.index), t]));

function resolveOne(arg) {
  if (arg == null) return null;
  let s = String(arg).trim();
  if (!s) return null;
  const hadAt = s.startsWith('@');
  if (hadAt) s = s.slice(1);
  if (/^-\d+$/.test(s)) {
    // Acepta tanto number como string (Telegram admite ambos)
    return byId.get(s) || { id: s, alias: s, name: s, type: 'group', index: -1, direct: true };
  }
  if (/^\d+$/.test(s)) return byIndex.get(s) || null;
  const byA = byAlias.get(s.toLowerCase());
  if (byA) return byA;
  // @username directo (canales públicos): la Bot API acepta @nombre como chat_id
  if (hadAt && /^[A-Za-z0-9_]{5,32}$/.test(s)) {
    return { id: '@' + s, alias: '@' + s, name: '@' + s, type: 'channel', index: -1, direct: true };
  }
  return null;
}

function splitList(text) {
  return String(text || '')
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// Quita "/comando@bot args" -> "args"
function argsAfterCommand(text) {
  const t = String(text || '');
  const firstSpace = t.indexOf(' ');
  if (firstSpace === -1) return '';
  return t.slice(firstSpace + 1).trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Cache de admins ----
const adminCache = new Map(); // key chatId:userId -> { isAdmin, exp }
async function isAdmin(telegram, chatId, userId) {
  const key = `${chatId}:${userId}`;
  const now = Date.now() / 1000;
  const hit = adminCache.get(key);
  if (hit && hit.exp > now) return hit.isAdmin;
  try {
    const m = await telegram.getChatMember(chatId, userId);
    const isAdmin = m && (m.status === 'creator' || m.status === 'administrator');
    adminCache.set(key, { isAdmin, exp: now + ADMIN_CACHE_TTL });
    return isAdmin;
  } catch (e) {
    // Si el bot no puede leer admins (no es admin), niega por seguridad y avisa en log
    console.error(`[admin-check] no pude verificar admin en ${chatId}:`, e?.response?.description || e.message);
    return false;
  }
}

async function requireAdmin(ctx) {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (!userId || ctx.from?.is_bot) {
    await ctx.reply('⛔ Solo personas administradoras pueden usar este comando.');
    return false;
  }
  const ok = await isAdmin(ctx.telegram, chatId, userId);
  if (!ok) {
    await ctx.reply('⛔ Solo admins de este grupo pueden usar este comando.', {
      reply_to_message_id: ctx.message.message_id,
    }).catch(() => {});
    return false;
  }
  return true;
}

function requireSource(ctx) {
  if (String(ctx.chat?.id) !== String(SOURCE_GROUP_ID)) {
    ctx.reply(`⚠️ Este comando solo funciona en el grupo origen (${SOURCE_GROUP_ID}). Este chat es ${ctx.chat?.id}.`).catch(() => {});
    return false;
  }
  return true;
}

function requireReply(ctx) {
  const q = ctx.message?.reply_to_message;
  if (!q) {
    ctx.reply('⚠️ Cita (responde) un mensaje primero y luego manda el comando. Ej: cita una foto + /enviar', {
      reply_to_message_id: ctx.message.message_id,
    }).catch(() => {});
    return null;
  }
  return q;
}

// Copia 1 mensaje a 1 destino, con 1 reintento en FloodWait y fallback a forward
async function copyTo(telegram, destId, fromChatId, messageId) {
  try {
    await telegram.copyMessage(destId, fromChatId, messageId);
    return { ok: true };
  } catch (e) {
    const desc = e?.response?.description || e.message || '';
    const params = e?.response?.parameters || e?.parameters || {};
    // FloodWait -> espera lo que pide Telegram y reintenta 1 vez
    if (e?.response?.error_code === 429 && params.retry_after) {
      const wait = Math.min(60, Number(params.retry_after) || 2) * 1000;
      console.warn(`[429] destino ${destId}, espero ${wait}ms y reintento`);
      await sleep(wait);
      try {
        await telegram.copyMessage(destId, fromChatId, messageId);
        return { ok: true };
      } catch (e2) {
        return { ok: false, error: e2?.response?.description || e2.message };
      }
    }
    // copyMessage no soporta el tipo (ej. polls, servicios) -> intenta forward
    if (/can't copy|not supported|service message|poll/i.test(desc)) {
      try {
        await telegram.forwardMessage(destId, fromChatId, messageId);
        return { ok: true, via: 'forward' };
      } catch (e2) {
        return { ok: false, error: e2?.response?.description || e2.message };
      }
    }
    return { ok: false, error: desc };
  }
}

// Traduce errores tipicos de Telegram a causa accionable en español
function hintFor(destLabel, errDesc) {
  const d = String(errDesc || '');
  if (/bot is not an administrator|not enough rights|need administrator|CHANNEL_PRIVATE|have no rights/i.test(d))
    return `${destLabel}: el bot NO es admin del canal (o sin permiso Publicar mensajes). Info del canal → Administradores → añade @bot con Publicar mensajes.`;
  if (/chat not found/i.test(d))
    return `${destLabel}: ID incorrecto o el bot no esta dentro. Revisa el ID con /id dentro del canal.`;
  if (/bot was kicked|bot was blocked|kicked from|blocked/i.test(d))
    return `${destLabel}: sacaron o bloquearon al bot. Vuelve a agregarlo.`;
  if (/too many requests|flood/i.test(d))
    return `${destLabel}: FloodWait (límite de Telegram). Sube SEND_DELAY_MS a 200 y reintenta.`;
  if (/message to copy not found/i.test(d))
    return `${destLabel}: no se encontró el mensaje citado (¿se borró?).`;
  return `${destLabel}: ${d.slice(0, 160)}`;
}

async function fanOut(ctx, quoted, dests) {
  const fromChatId = ctx.chat.id;
  const messageId = quoted.message_id;
  let ok = 0;
  const failed = [];
  const total = dests.length;

  const statusMsg = await ctx.reply(`⏳ Enviando a ${total}...`, {
    reply_to_message_id: ctx.message.message_id,
  }).catch(() => null);

  for (let i = 0; i < dests.length; i++) {
    const d = dests[i];
    const r = await copyTo(ctx.telegram, d.id, fromChatId, messageId);
    if (r.ok) {
      ok++;
      console.log(`[OK] ${d.alias || d.id} (${i + 1}/${total})${r.via ? ' via ' + r.via : ''}`);
    } else {
      const label = `${d.alias || d.id}`;
      failed.push(hintFor(label, r.error));
      console.error(`[FAIL] ${label}: ${r.error}`);
    }
    if (SEND_DELAY_MS > 0 && i < dests.length - 1) await sleep(SEND_DELAY_MS);
  }

  let text = `✅ Enviado ${ok}/${total}.`;
  if (failed.length) text += `\n❌ Falló (${failed.length}):\n- ${failed.slice(0, 8).join('\n- ')}${failed.length > 8 ? `\n…y ${failed.length - 8} más (mira la terminal)` : ''}`;
  if (statusMsg) {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, text).catch(() =>
      ctx.reply(text, { reply_to_message_id: ctx.message.message_id }).catch(() => {})
    );
  } else {
    await ctx.reply(text, { reply_to_message_id: ctx.message.message_id }).catch(() => {});
  }
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => ctx.reply(
  '🤖 Bot espejo por cita.\n\nCita un mensaje y usa:\n/enviar → a todos\n/enviar_a <alias|ID|nº> → a uno\n/enviar_varios <a,b,c> → a varios\n\n/grupos → ver destinos\n/id → ver IDs\n/help → ayuda'
));
bot.help((ctx) => ctx.reply(
  '📌 Uso (solo admins, solo en el grupo origen, CITANDO un mensaje):\n\n' +
  '• /enviar — cita + comando → envía a TODOS\n' +
  '• /enviar_a vip — cita + comando → envía a 1 (alias, ID -100… o nº de /grupos)\n' +
  '• /enviar_varios vip,ventas,canal1 — cita + comando → envía a varios\n\n' +
  '• /grupos — lista destinos\n• /id — muestra chat.id y tu user.id'
));

bot.command('id', async (ctx) => {
  const lines = [`chat.id: \`${ctx.chat?.id}\``, `tu user.id: \`${ctx.from?.id}\``];
  if (ctx.message?.reply_to_message) lines.push(`mensaje citado id: \`${ctx.message.reply_to_message.message_id}\``);
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
});

async function replyTargets(ctx) {
  const lines = TARGETS.map((t) => `${t.index}. ${t.alias} — ${t.name} (${t.type}) \`${t.id}\``);
  const header = `🎯 Destinos (${TARGETS.length}):\n`;
  // Parte en trozos para no pasar el limite de 4096
  let chunk = header;
  for (const l of lines) {
    if ((chunk + l + '\n').length > 3800) {
      await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() => {});
      chunk = '';
    }
    chunk += l + '\n';
  }
  if (chunk.trim()) await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() => {});
  await ctx.reply('Usa: /enviar_a vip  ·  /enviar_varios vip,ventas').catch(() => {});
}

bot.command('grupos', replyTargets);

// En canales, Telegram manda "/id" como texto plano SIN entidad bot_command,
// asi que bot.command() nunca dispara. Se escucha channel_post a mano.
// (Quien publica en un canal es admin por definicion: no hace falta check.)
bot.on(['channel_post', 'edited_channel_post'], async (ctx) => {
  const post = ctx.update.channel_post || ctx.update.edited_channel_post || {};
  const text = String(post.text || post.caption || '').trim();
  if (!/^\/\w+/.test(text)) return;
  const cmd = text.split(/\s+/)[0].replace(/@.+$/, '').toLowerCase();
  if (cmd === '/id') {
    await ctx.reply(
      `channel.id: \`${ctx.chat.id}\`\nPégalo en targets.json con "type": "channel".` +
      (post.chat?.username ? `\nO usa directo: /enviar_a @${post.chat.username}` : ''),
      { parse_mode: 'Markdown' }
    ).catch((e) => console.error('[channel /id] no pude responder:', e?.response?.description || e.message));
  } else if (cmd === '/grupos') {
    await replyTargets(ctx);
  }
  // /enviar* NO se habilitan desde canales: el origen es el grupo.
});

bot.command('enviar', async (ctx) => {
  if (!requireSource(ctx)) return;
  if (!(await requireAdmin(ctx))) return;
  const quoted = requireReply(ctx);
  if (!quoted) return;
  await fanOut(ctx, quoted, TARGETS);
});

bot.command('enviar_a', async (ctx) => {
  if (!requireSource(ctx)) return;
  if (!(await requireAdmin(ctx))) return;
  const quoted = requireReply(ctx);
  if (!quoted) return;
  const arg = argsAfterCommand(ctx.message.text);
  if (!arg) {
    await ctx.reply('⚠️ Uso: cita un mensaje y manda `/enviar_a vip` (alias, ID -100… o nº de /grupos).', {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id,
    }).catch(() => {});
    return;
  }
  const dest = resolveOne(arg.split(/[\s,;]+/)[0]);
  if (!dest) {
    await ctx.reply(`⚠️ No encontré "${arg}". Mira /grupos y usa alias, ID o número.`, {
      reply_to_message_id: ctx.message.message_id,
    }).catch(() => {});
    return;
  }
  await fanOut(ctx, quoted, [dest]);
});

bot.command('enviar_varios', async (ctx) => {
  if (!requireSource(ctx)) return;
  if (!(await requireAdmin(ctx))) return;
  const quoted = requireReply(ctx);
  if (!quoted) return;
  const rawArgs = argsAfterCommand(ctx.message.text);
  if (!rawArgs) {
    await ctx.reply('⚠️ Uso: cita un mensaje y manda `/enviar_varios vip,ventas,canal1`.', {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id,
    }).catch(() => {});
    return;
  }
  const parts = splitList(rawArgs);
  const dests = [];
  const missing = [];
  for (const p of parts) {
    const d = resolveOne(p);
    if (d) {
      if (!dests.some((x) => String(x.id) === String(d.id))) dests.push(d);
    } else missing.push(p);
  }
  if (dests.length === 0) {
    await ctx.reply(`⚠️ No reconocí ninguno: ${missing.join(', ')}. Mira /grupos.`, {
      reply_to_message_id: ctx.message.message_id,
    }).catch(() => {});
    return;
  }
  if (missing.length) {
    await ctx.reply(`ℹ️ No encontré: ${missing.join(', ')}. Sigo con ${dests.length}.`, {
      reply_to_message_id: ctx.message.message_id,
    }).catch(() => {});
  }
  await fanOut(ctx, quoted, dests);
});

// Ignora el resto (no es espejo automatico: solo por comando)
bot.on('message', () => {});

bot.catch((err, ctx) => console.error('[bot error]', err?.response?.description || err.message));

bot.launch().then(() => {
  console.log(`[OK] Bot corriendo. Origen: ${SOURCE_GROUP_ID} | Destinos: ${TARGETS.length} | Delay: ${SEND_DELAY_MS}ms`);
  console.log('Comandos: /enviar /enviar_a /enviar_varios /grupos /id (solo admins del origen, citando mensaje)');
}).catch((e) => {
  const desc = e?.response?.description || e.message || e;
  if (e?.response?.error_code === 401) {
    console.error('[FATAL] Token invalido (401 Unauthorized). Revisa BOT_TOKEN en .env con el de @BotFather.');
  } else {
    console.error('[FATAL] No pude arrancar el bot:', desc);
  }
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
