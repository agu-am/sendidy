// Bot multi-tenant: cada dueño vincula SU grupo origen y SUS destinos.
// Nada se mezcla: todo fan-out filtra por owner_id.
// Uso con cita: /enviar (todos) · /enviar_a <uno> · /enviar_varios <lista>
const { Telegraf } = require('telegraf');
const db = require('./db');
const { splitList, argsAfterCommand, resolveInList, hintFor, formatStats, validateBackup } = require('./util');

const SEND_DELAY_MS = Math.max(0, parseInt(process.env.SEND_DELAY_MS || '80', 10) || 0);
const ADMIN_CACHE_TTL = Math.max(30, parseInt(process.env.ADMIN_CACHE_TTL || '300', 10) || 300);
const ADMIN_IDS = new Set(
  String(process.env.ADMIN_IDS || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)
);

// Planes
const FREE_MAX_DESTS = 3;
const PRO_MAX_DESTS = 50;
const FREE_DAILY_SENDS = 30;
const PRO_DAILY_SENDS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Cache de admins del chat ----
const adminCache = new Map();
async function isAdmin(telegram, chatId, userId) {
  const key = `${chatId}:${userId}`;
  const now = Date.now() / 1000;
  const hit = adminCache.get(key);
  if (hit && hit.exp > now) return hit.isAdmin;
  try {
    const m = await telegram.getChatMember(chatId, userId);
    const ok = m && (m.status === 'creator' || m.status === 'administrator');
    adminCache.set(key, { isAdmin: ok, exp: now + ADMIN_CACHE_TTL });
    return ok;
  } catch (e) {
    console.error(`[admin-check] no pude verificar admin en ${chatId}:`, e?.response?.description || e.message);
    return false;
  }
}

async function requireAdmin(ctx) {
  const userId = ctx.from?.id;
  if (!userId || ctx.from?.is_bot) {
    await ctx.reply('⛔ Solo personas administradoras pueden usar este comando.').catch(() => {});
    return false;
  }
  if (!(await isAdmin(ctx.telegram, ctx.chat.id, userId))) {
    await ctx.reply('⛔ Solo admins de este grupo pueden usar este comando.', {
      reply_to_message_id: ctx.message.message_id,
    }).catch(() => {});
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

const isPrivate = (ctx) => ctx.chat?.type === 'private';
const isGroup = (ctx) => ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

// Dueño efectivo según contexto: en grupo vinculado = su dueño; en privado = el que escribe.
async function resolveOwner(ctx) {
  if (isPrivate(ctx)) {
    const owner = await db.ensureOwner(ctx.from.id);
    return { ownerId: ctx.from.id, plan: db.effectivePlan(owner), owner };
  }
  if (isGroup(ctx)) {
    const link = await db.getOriginOwner(ctx.chat.id);
    if (!link) return { ownerId: null };
    const owner = await db.getOwner(link.owner_id);
    return { ownerId: Number(link.owner_id), plan: db.effectivePlan(owner), owner };
  }
  return { ownerId: null };
}

// ---- Envio ----
async function copyTo(telegram, destId, fromChatId, messageId) {
  try {
    await telegram.copyMessage(destId, fromChatId, messageId);
    return { ok: true };
  } catch (e) {
    const desc = e?.response?.description || e.message || '';
    const params = e?.response?.parameters || e?.parameters || {};
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

async function fanOut(ctx, ownerId, quoted, dests) {
  const fromChatId = ctx.chat.id;
  const messageId = quoted.message_id;
  let ok = 0;
  const failed = [];
  const statusMsg = await ctx.reply(`⏳ Enviando a ${dests.length}...`, {
    reply_to_message_id: ctx.message.message_id,
  }).catch(() => null);

  for (let i = 0; i < dests.length; i++) {
    const d = dests[i];
    const r = await copyTo(ctx.telegram, d.id, fromChatId, messageId);
    if (r.ok) {
      ok++;
      console.log(`[OK] owner=${ownerId} ${d.alias || d.id} (${i + 1}/${dests.length})${r.via ? ' via ' + r.via : ''}`);
    } else {
      failed.push(hintFor(d.alias || String(d.id), r.error));
      console.error(`[FAIL] owner=${ownerId} ${d.alias || d.id}: ${r.error}`);
    }
    if (SEND_DELAY_MS > 0 && i < dests.length - 1) await sleep(SEND_DELAY_MS);
  }
  await db.logFanout(ownerId, fromChatId, dests.length, ok);

  let text = `✅ Enviado ${ok}/${dests.length}.`;
  if (failed.length) {
    text += `\n❌ Falló (${failed.length}):\n- ${failed.slice(0, 8).join('\n- ')}${failed.length > 8 ? `\n…y ${failed.length - 8} más` : ''}`;
  }
  if (statusMsg) {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, text).catch(() =>
      ctx.reply(text, { reply_to_message_id: ctx.message.message_id }).catch(() => {})
    );
  } else {
    await ctx.reply(text, { reply_to_message_id: ctx.message.message_id }).catch(() => {});
  }
}

// Quota + resolucion comun para /enviar*
async function prepareSend(ctx, rawArgs, mode) {
  const link = await db.getOriginOwner(ctx.chat.id);
  if (!link) {
    await ctx.reply(
      '⚠️ Este grupo no está vinculado a ningún dueño.\n1️⃣ Háblame en privado: /start\n2️⃣ En este grupo (como admin): /vincular VINC-XXXX',
      { reply_to_message_id: ctx.message.message_id }
    ).catch(() => {});
    return null;
  }
  if (!(await requireAdmin(ctx))) return null;
  const quoted = requireReply(ctx);
  if (!quoted) return null;

  const ownerId = Number(link.owner_id);
  const owner = await db.getOwner(ownerId);
  const plan = db.effectivePlan(owner);
  const maxDests = plan === 'pro' ? PRO_MAX_DESTS : FREE_MAX_DESTS;
  const dailyCap = plan === 'pro' ? PRO_DAILY_SENDS : FREE_DAILY_SENDS;
  const used = await db.countToday(ownerId);
  if (used >= dailyCap) {
    await ctx.reply(
      `⛔ Límite diario alcanzado (${used}/${dailyCap} envíos, plan ${plan}).` +
      (plan === 'free' ? ' Pasa a Pro para ampliar.' : ' Reintenta en 24h.'),
      { reply_to_message_id: ctx.message.message_id }
    ).catch(() => {});
    return null;
  }

  const dests = await db.listGroups(ownerId, 'destino');
  if (dests.length === 0) {
    await ctx.reply('⚠️ No tienes destinos. En cada grupo/canal: /agregar <alias> (o en privado: /agregar <ID> <alias>).', {
      reply_to_message_id: ctx.message.message_id,
    }).catch(() => {});
    return null;
  }

  if (mode === 'all') return { ownerId, plan, quoted, dests: dests.slice(0, maxDests) };

  const parts = mode === 'one' ? [String(rawArgs || '').split(/[\s,;]+/)[0]] : splitList(rawArgs);
  if (!parts[0]) {
    const uso = mode === 'one'
      ? '⚠️ Uso: cita y manda `/enviar_a vip` (alias, ID -100… o nº de /misgrupos).'
      : '⚠️ Uso: cita y manda `/enviar_varios vip,ventas,canal1`.';
    await ctx.reply(uso, { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }).catch(() => {});
    return null;
  }
  const picked = [];
  const missing = [];
  for (const p of parts) {
    const r = resolveInList(p, dests);
    if (!r) { missing.push(p); continue; }
    if (r.kind === 'direct' && plan !== 'pro') {
      await ctx.reply(`⚠️ "${p}" no está en tu lista: los destinos directos (@username o ID suelto) son solo Pro. Agrégalo con /agregar.`, {
        reply_to_message_id: ctx.message.message_id,
      }).catch(() => {});
      return null;
    }
    const dest = r.kind === 'listed' ? r.dest : { id: r.id, alias: String(r.id), name: String(r.id), type: 'channel', index: -1 };
    if (!picked.some((x) => String(x.id) === String(dest.id))) picked.push(dest);
  }
  if (picked.length === 0) {
    await ctx.reply(`⚠️ No reconocí ninguno: ${missing.join(', ')}. Mira /misgrupos.`, {
      reply_to_message_id: ctx.message.message_id,
    }).catch(() => {});
    return null;
  }
  if (missing.length) {
    await ctx.reply(`ℹ️ No encontré: ${missing.join(', ')}. Sigo con ${picked.length}.`, {
      reply_to_message_id: ctx.message.message_id,
    }).catch(() => {});
  }
  return { ownerId, plan, quoted, dests: picked.slice(0, maxDests) };
}

async function replyTargets(ctx, ownerId) {
  const origins = await db.listGroups(ownerId, 'origen');
  const dests = await db.listGroups(ownerId, 'destino');
  const owner = await db.getOwner(ownerId);
  const plan = db.effectivePlan(owner);
  let chunk = `🎯 Tus grupos (plan ${plan}${owner?.expires_at ? ` hasta ${new Date(owner.expires_at).toLocaleDateString()}` : ''}):\nOrigen:\n`;
  chunk += origins.length ? origins.map((o) => `• ${o.name} \`${o.id}\``).join('\n') : '(sin vincular: /vincular CODIGO)';
  chunk += `\nDestinos (${dests.length}):\n`;
  const lines = dests.map((t) => `${t.index}. ${t.alias} — ${t.name} (${t.type}) \`${t.id}\``);
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

function createBot(token) {
  const bot = new Telegraf(token);

  // Log de cada update con latencia (visible en Render Logs)
  bot.use(async (ctx, next) => {
    const t0 = Date.now();
    try {
      await next();
    } finally {
      const ms = Date.now() - t0;
      const who = ctx.from?.id ?? '?';
      const where = ctx.chat?.id ?? ctx.update?.channel_post?.chat?.id ?? '?';
      console.log(`[update] ${ctx.updateType} chat=${where} from=${who} ${ms}ms${ms > 5000 ? ' SLOW' : ''}`);
    }
  });

  bot.start(async (ctx) => {
    if (!isPrivate(ctx)) {
      await ctx.reply('🤖 Háblame en privado para vincular tus grupos: /start').catch(() => {});
      return;
    }
    const owner = await db.ensureOwner(ctx.from.id);
    const { code } = await db.createLinkCode(ctx.from.id);
    const isSuper = ADMIN_IDS.has(String(ctx.from.id));
    await ctx.reply(
      `👋 Tu código para vincular grupos (15 min):\n\`${code}\`\n\n` +
      `1️⃣ Agrega al bot a tu grupo origen\n2️⃣ Ahí (como admin) manda: /vincular ${code}\n3️⃣ En cada destino: /agregar <alias>\n\n` +
      `Comandos: /misgrupos · /plan · /stats · /agregar · /quitar · /backup · /id\n` +
      (isSuper ? `\n🛠️ Admin: /activar <user_id> <free|pro> [dias]` : ``) +
      `\nPlan actual: ${db.effectivePlan(owner)} (Free: 1 origen + ${FREE_MAX_DESTS} destinos)`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  });
  bot.help((ctx) => ctx.reply(
    '📌 Cita un mensaje (solo admins, solo en tu grupo vinculado):\n\n' +
    '• /enviar — a TODOS tus destinos\n' +
    '• /enviar_a vip — a 1 (alias, ID o nº de /misgrupos)\n' +
    '• /enviar_varios vip,ventas — a varios\n\n' +
    '• /vincular CODIGO — hace este grupo tu origen\n' +
    '• /agregar <alias> — hace este chat tu destino\n' +
    '• /misgrupos · /plan · /stats · /quitar · /id\n' +
    '• En privado: /backup (descarga tu config) · /restore (citando el .json lo reimporta)'
  ));

  bot.command('id', async (ctx) => {
    const lines = [`chat.id: \`${ctx.chat?.id}\``, `tu user.id: \`${ctx.from?.id}\``];
    if (ctx.message?.reply_to_message) lines.push(`mensaje citado id: \`${ctx.message.reply_to_message.message_id}\``);
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' }).catch(() => {});
  });

  bot.command('plan', async (ctx) => {
    const r = await resolveOwner(ctx);
    if (!r.ownerId) {
      await ctx.reply('⚠️ Sin dueño aquí. En privado usa /start; en tu grupo, /vincular CODIGO.').catch(() => {});
      return;
    }
    const used = await db.countToday(r.ownerId);
    const cap = r.plan === 'pro' ? PRO_DAILY_SENDS : FREE_DAILY_SENDS;
    const maxD = r.plan === 'pro' ? PRO_MAX_DESTS : FREE_MAX_DESTS;
    await ctx.reply(
      `📦 Plan ${r.plan}${r.owner?.expires_at ? ` (hasta ${new Date(r.owner.expires_at).toLocaleDateString()})` : ''}\n` +
      `Destinos máx: ${maxD} · Envíos hoy: ${used}/${cap}`
    ).catch(() => {});
  });

  bot.command('vincular', async (ctx) => {
    if (!isGroup(ctx)) {
      await ctx.reply('⚠️ /vincular se usa DENTRO del grupo que será tu origen.').catch(() => {});
      return;
    }
    const code = argsAfterCommand(ctx.message.text).split(/\s+/)[0] || '';
    if (!code) {
      await ctx.reply('⚠️ Uso: /vincular VINC-XXXX (pide tu código con /start en privado).').catch(() => {});
      return;
    }
    const row = await db.consumeLinkCode(code);
    if (!row) {
      await ctx.reply('⚠️ Código inválido, usado o vencido. Pide otro con /start.').catch(() => {});
      return;
    }
    if (!(await requireAdmin(ctx))) return; // el runner debe ser admin del grupo
    const r = await db.linkOrigin(ctx.chat.id, row.user_id, ctx.chat.title, ctx.chat.type === 'channel' ? 'channel' : 'group');
    if (!r.ok) {
      const msg = r.reason === 'ya_vinculado_propio'
        ? 'ℹ️ Este grupo ya es tu origen.'
        : '⛔ Este grupo ya es origen de OTRO dueño. Pide al dueño que lo libere o usa otro grupo.';
      await ctx.reply(msg).catch(() => {});
      return;
    }
    await ctx.reply(
      `✅ Grupo vinculado como origen del dueño \`${row.user_id}\`.\nAhora en cada destino manda /agregar <alias>. Lista: /misgrupos.`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  });

  bot.command('agregar', async (ctx) => {
    const arg = argsAfterCommand(ctx.message.text);
    if (isGroup(ctx)) {
      // /agregar <alias> en el destino: dueño = dueño del... no: el que agrega es el sender.
      // Si el grupo es origen vinculado, el destino se suma a ESE dueño (flujo equipo).
      const link = await db.getOriginOwner(ctx.chat.id);
      const parts = splitList(arg);
      if (link) {
        // Estamos en un grupo ya vinculado como origen: alias para... no, agregar el MISMO chat como destino no tiene sentido.
        await ctx.reply('ℹ️ Este chat ya es origen. Para agregar destinos ve a cada grupo/canal y manda /agregar <alias>, o en privado: /agregar <ID> <alias>.').catch(() => {});
        return;
      }
      const alias = (parts[0] || '').toLowerCase();
      if (!/^[a-z0-9_]{2,24}$/.test(alias)) {
        await ctx.reply('⚠️ Uso: /agregar <alias> (2-24 letras/números/_). Ej: /agregar vip').catch(() => {});
        return;
      }
      if (!(await requireAdmin(ctx))) return;
      const owner = await db.ensureOwner(ctx.from.id);
      const plan = db.effectivePlan(owner);
      if ((await db.countDests(ctx.from.id)) >= (plan === 'pro' ? PRO_MAX_DESTS : FREE_MAX_DESTS)) {
        await ctx.reply(`⛔ Tope de destinos del plan ${plan}. ${plan === 'free' ? 'Pasa a Pro.' : ''}`).catch(() => {});
        return;
      }
      const r = await db.addDest(ctx.chat.id, ctx.from.id, alias, ctx.chat.type, ctx.chat.title);
      if (!r.ok) {
        await ctx.reply('⚠️ Ese alias ya lo usas. Elige otro o /quitar.').catch(() => {});
        return;
      }
      await ctx.reply(`✅ Destino "${alias}" agregado a tu cuenta. Ver: /misgrupos.`).catch(() => {});
      return;
    }
    if (isPrivate(ctx)) {
      // /agregar <chat_id> <alias>
      const parts = splitList(arg);
      if (parts.length < 2 || !/^-\d+$/.test(parts[0])) {
        await ctx.reply('⚠️ Uso en privado: /agregar <ID> <alias>. Ej: /agregar -100123... canal1 (saca el ID con /id dentro del canal).').catch(() => {});
        return;
      }
      const alias = parts[1].toLowerCase();
      if (!/^[a-z0-9_]{2,24}$/.test(alias)) {
        await ctx.reply('⚠️ Alias inválido (2-24 letras/números/_).').catch(() => {});
        return;
      }
      // Verifica que el bot esté dentro de ese chat
      try {
        await ctx.telegram.getChatMember(parts[0], ctx.botInfo.id);
      } catch (e) {
        await ctx.reply('⛔ No estoy en ese chat (o el ID está mal). Agrégame ahí primero; en canales como admin con Publicar mensajes.').catch(() => {});
        return;
      }
      const owner = await db.ensureOwner(ctx.from.id);
      const plan = db.effectivePlan(owner);
      if ((await db.countDests(ctx.from.id)) >= (plan === 'pro' ? PRO_MAX_DESTS : FREE_MAX_DESTS)) {
        await ctx.reply(`⛔ Tope de destinos del plan ${plan}.`).catch(() => {});
        return;
      }
      let info = {};
      try { const c = await ctx.telegram.getChat(parts[0]); info = { type: c.type === 'channel' ? 'channel' : 'group', name: c.title }; } catch (e) { /* sigue */ }
      const r = await db.addDest(parts[0], ctx.from.id, alias, info.type, info.name);
      if (!r.ok) {
        await ctx.reply('⚠️ Ese alias ya lo usas.').catch(() => {});
        return;
      }
      await ctx.reply(`✅ Destino "${alias}" agregado.`).catch(() => {});
      return;
    }
  });

  bot.command('quitar', async (ctx) => {
    const ref = argsAfterCommand(ctx.message.text).split(/[\s,;]+/)[0] || '';
    if (!ref) {
      await ctx.reply('⚠️ Uso: /quitar <alias o ID>.').catch(() => {});
      return;
    }
    let ownerId;
    if (isPrivate(ctx)) ownerId = ctx.from.id;
    else if (isGroup(ctx)) {
      const link = await db.getOriginOwner(ctx.chat.id);
      if (!link) { await ctx.reply('⚠️ Grupo no vinculado.').catch(() => {}); return; }
      if (!(await requireAdmin(ctx))) return;
      ownerId = Number(link.owner_id);
    } else return;
    const ok = await db.removeDest(ownerId, ref);
    await ctx.reply(ok ? `✅ Quitado "${ref}".` : `⚠️ No encontré "${ref}". Mira /misgrupos.`).catch(() => {});
  });

  bot.command('misgrupos', async (ctx) => {
    const r = await resolveOwner(ctx);
    if (!r.ownerId) {
      await ctx.reply('⚠️ Sin dueño aquí. En privado: /start. En tu grupo: /vincular CODIGO.').catch(() => {});
      return;
    }
    await replyTargets(ctx, r.ownerId);
  });
  bot.command('grupos', async (ctx) => {
    const r = await resolveOwner(ctx);
    if (!r.ownerId) {
      await ctx.reply('⚠️ Sin dueño aquí. En privado: /start. En tu grupo: /vincular CODIGO.').catch(() => {});
      return;
    }
    await replyTargets(ctx, r.ownerId);
  });

  bot.command('stats', async (ctx) => {
    const r = await resolveOwner(ctx);
    if (!r.ownerId) {
      await ctx.reply('⚠️ Sin dueño aquí. En privado: /start. En tu grupo: /vincular CODIGO.').catch(() => {});
      return;
    }
    const st = await db.getStats(r.ownerId);
    const maxDests = r.plan === 'pro' ? PRO_MAX_DESTS : FREE_MAX_DESTS;
    const cap = r.plan === 'pro' ? PRO_DAILY_SENDS : FREE_DAILY_SENDS;
    await ctx.reply(formatStats({
      plan: r.plan,
      expires: r.owner?.expires_at ? new Date(r.owner.expires_at).toLocaleDateString() : null,
      origins: st.origins, dests: st.dests, maxDests,
      todaySends: st.today, todayCap: cap,
      w7: st.w7, m30: st.m30, recent: st.recent,
    })).catch(() => {});
  });

  bot.command('backup', async (ctx) => {
    if (!isPrivate(ctx)) {
      await ctx.reply('⚠️ Por seguridad, /backup solo funciona en chat privado conmigo.').catch(() => {});
      return;
    }
    const data = await db.exportOwner(ctx.from.id);
    const stamp = new Date().toISOString().slice(0, 10);
    await ctx.replyWithDocument(
      { source: Buffer.from(JSON.stringify(data, null, 2), 'utf8'), filename: `backup-mirror-${ctx.from.id}-${stamp}.json` },
      { caption: `💾 Tu backup: ${data.origins.length} origen(es), ${data.dests.length} destino(s). Guárdalo; con /restore (citando el archivo) lo reimportas.` }
    ).catch(() => {});
  });

  bot.command('restore', async (ctx) => {
    if (!isPrivate(ctx)) {
      await ctx.reply('⚠️ Por seguridad, /restore solo funciona en chat privado conmigo.').catch(() => {});
      return;
    }
    const doc = ctx.message?.reply_to_message?.document;
    if (!doc || !/\.json$/i.test(doc.file_name || '')) {
      await ctx.reply('⚠️ Uso: reenvíame tu .json de backup, CÍTALO y manda /restore.', {
        reply_to_message_id: ctx.message.message_id,
      }).catch(() => {});
      return;
    }
    if ((doc.file_size || 0) > 1024 * 1024) {
      await ctx.reply('⚠️ Archivo muy grande (>1MB). ¿Es el backup del bot?').catch(() => {});
      return;
    }
    let data;
    try {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const res = await fetch(link.href);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      await ctx.reply(`⚠️ No pude leer el archivo: ${e.message}`).catch(() => {});
      return;
    }
    const v = validateBackup(data);
    if (!v.ok) {
      await ctx.reply(`⚠️ ${v.error}`).catch(() => {});
      return;
    }
    const owner = await db.ensureOwner(ctx.from.id);
    const plan = db.effectivePlan(owner);
    const res2 = await db.importOwnerData(ctx.from.id, data, plan === 'pro' ? PRO_MAX_DESTS : FREE_MAX_DESTS);
    const lines = [
      `♻️ Restore listo (plan ${plan}):`,
      `Orígenes: ${res2.originsOk} ok${res2.originsSkipped.length ? `, omitidos: ${res2.originsSkipped.join('; ')}` : ''}`,
      `Destinos: ${res2.destsOk} ok${res2.destsSkipped.length ? `, omitidos: ${res2.destsSkipped.join('; ')}` : ''}`,
    ];
    await ctx.reply(lines.join('\n')).catch(() => {});
  });

  bot.command('backup_all', async (ctx) => {
    if (!ADMIN_IDS.has(String(ctx.from?.id))) {
      await ctx.reply('⛔ Solo el administrador del servicio.').catch(() => {});
      return;
    }
    if (!isPrivate(ctx)) {
      await ctx.reply('⚠️ Por seguridad, /backup_all solo en privado.').catch(() => {});
      return;
    }
    const data = await db.exportAll();
    const stamp = new Date().toISOString().slice(0, 10);
    await ctx.replyWithDocument(
      { source: Buffer.from(JSON.stringify(data, null, 2), 'utf8'), filename: `backup-all-${stamp}.json` },
      { caption: `💾 Backup global: ${data.owners.length} dueño(s). Guárdalo fuera del servidor.` }
    ).catch(() => {});
  });

  bot.command('activar', async (ctx) => {
    if (!ADMIN_IDS.has(String(ctx.from?.id))) {
      await ctx.reply('⛔ Solo el administrador del servicio.').catch(() => {});
      return;
    }
    const [target, plan, days] = splitList(argsAfterCommand(ctx.message.text));
    if (!/^\d+$/.test(target || '') || !['free', 'pro'].includes((plan || '').toLowerCase())) {
      await ctx.reply('⚠️ Uso: /activar <user_id> <free|pro> [dias]. Ej: /activar 123456 pro 30').catch(() => {});
      return;
    }
    const row = await db.setPlan(target, plan.toLowerCase(), days);
    await ctx.reply(`✅ Usuario \`${target}\` → plan ${row.plan}${row.expires_at ? ` hasta ${new Date(row.expires_at).toLocaleDateString()}` : ' (sin vencimiento)'}.`, { parse_mode: 'Markdown' }).catch(() => {});
  });

  bot.command('enviar', async (ctx) => {
    if (!isGroup(ctx)) { await ctx.reply('⚠️ /enviar se usa en tu grupo vinculado.').catch(() => {}); return; }
    const p = await prepareSend(ctx, '', 'all');
    if (!p) return;
    await fanOut(ctx, p.ownerId, p.quoted, p.dests);
  });

  bot.command('enviar_a', async (ctx) => {
    if (!isGroup(ctx)) { await ctx.reply('⚠️ /enviar_a se usa en tu grupo vinculado.').catch(() => {}); return; }
    const p = await prepareSend(ctx, argsAfterCommand(ctx.message.text), 'one');
    if (!p) return;
    await fanOut(ctx, p.ownerId, p.quoted, p.dests);
  });

  bot.command('enviar_varios', async (ctx) => {
    if (!isGroup(ctx)) { await ctx.reply('⚠️ /enviar_varios se usa en tu grupo vinculado.').catch(() => {}); return; }
    const r0 = await resolveOwner(ctx);
    if (!r0.ownerId) return;
    if (r0.plan !== 'pro') {
      await ctx.reply('⚠️ /enviar_varios es solo Pro. Con Free usa /enviar o /enviar_a.', {
        reply_to_message_id: ctx.message.message_id,
      }).catch(() => {});
      return;
    }
    const p = await prepareSend(ctx, argsAfterCommand(ctx.message.text), 'many');
    if (!p) return;
    await fanOut(ctx, p.ownerId, p.quoted, p.dests);
  });

  // Canales: /id y ayuda (los comandos llegan como texto plano, sin entidad bot_command)
  bot.on(['channel_post', 'edited_channel_post'], async (ctx) => {
    const post = ctx.update.channel_post || ctx.update.edited_channel_post || {};
    const text = String(post.text || post.caption || '').trim();
    if (!/^\/\w+/.test(text)) return;
    const cmd = text.split(/\s+/)[0].replace(/@.+$/, '').toLowerCase();
    if (cmd === '/id') {
      await ctx.reply(
        `channel.id: \`${ctx.chat.id}\`\nEn privado agrégalo: /agregar ${ctx.chat.id} <alias>.` +
        (post.chat?.username ? `\nO usa directo (Pro): /enviar_a @${post.chat.username}` : ''),
        { parse_mode: 'Markdown' }
      ).catch((e) => console.error('[channel /id] no pude responder:', e?.response?.description || e.message));
    } else if (cmd === '/agregar' || cmd === '/misgrupos' || cmd === '/enviar' || cmd === '/vincular') {
      await ctx.reply('ℹ️ En canales solo funciona /id. Gestiona todo desde privado (/start) o tu grupo. Recuerda borrar estos mensajes (visibles para suscriptores).').catch((e) =>
        console.error('[channel] no pude responder:', e?.response?.description || e.message));
    }
  });

  bot.on('message', () => {}); // ignora el resto: solo comandos
  bot.catch((err, ctx) => console.error('[bot error]', err?.response?.description || err.message));
  return bot;
}

module.exports = { createBot, FREE_MAX_DESTS, PRO_MAX_DESTS, FREE_DAILY_SENDS, PRO_DAILY_SENDS };
