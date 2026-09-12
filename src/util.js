// Helpers puros (sin Telegram ni DB) — cubiertos por scripts/selftest.js
const crypto = require('crypto');

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

// Codigo VINC-XXXX con alfabeto sin ambiguedades (sin 0/O/1/I)
function genLinkCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(4);
  let s = '';
  for (const b of bytes) s += abc[b % abc.length];
  return `VINC-${s}`;
}

// Resuelve UN destino dentro de la lista del dueño.
// -> { kind: 'listed', dest } | { kind: 'direct', id } | null
function resolveInList(arg, dests) {
  if (arg == null) return null;
  let s = String(arg).trim();
  if (!s) return null;
  const hadAt = s.startsWith('@');
  if (hadAt) s = s.slice(1);

  if (/^-\d+$/.test(s)) {
    const found = dests.find((d) => String(d.id) === s);
    if (found) return { kind: 'listed', dest: found };
    return { kind: 'direct', id: s }; // ID suelto: solo Pro (lo decide bot.js)
  }
  if (/^\d+$/.test(s)) {
    const idx = parseInt(s, 10);
    const found = dests[idx - 1]; // 1-based como muestra /misgrupos
    return found ? { kind: 'listed', dest: found } : null;
  }
  const found = dests.find((d) => String(d.alias).toLowerCase() === s.toLowerCase());
  if (found) return { kind: 'listed', dest: found };
  if (hadAt && /^[A-Za-z0-9_]{5,32}$/.test(s)) {
    return { kind: 'direct', id: '@' + s }; // @username publico: solo Pro
  }
  return null;
}

// Traduce errores tipicos de Telegram a causa accionable en español
function hintFor(destLabel, errDesc) {
  const d = String(errDesc || '');
  if (/bot is not an administrator|not enough rights|need administrator|have no rights/i.test(d))
    return `${destLabel}: el bot NO es admin del canal (o sin permiso Publicar mensajes). Info del canal → Administradores → añade al bot con Publicar mensajes.`;
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

module.exports = { splitList, argsAfterCommand, genLinkCode, resolveInList, hintFor };
