// Import one-off: pasa targets.json + origen legacy a Supabase para un dueño.
// Uso: node scripts/import_targets.js <owner_user_id> [ruta_targets.json]
// Env: IMPORT_ORIGIN_ID (chat id del grupo origen), DATABASE_URL en .env
require('dotenv').config();
const fs = require('fs');
const db = require('../src/db');

async function main() {
  const ownerId = Number(process.argv[2]);
  const file = process.argv[3] || 'targets.json';
  const originId = Number(process.env.IMPORT_ORIGIN_ID || '');
  if (!ownerId) {
    console.error('Uso: node scripts/import_targets.js <owner_user_id> [targets.json]');
    process.exit(1);
  }
  await db.ping();
  await db.ensureOwner(ownerId);
  let done = 0, skipped = 0;
  if (originId) {
    const r = await db.linkOrigin(originId, ownerId, 'origen importado', 'group');
    console.log(r.ok ? `[OK] origen ${originId}` : `[SKIP] origen ${originId} (${r.reason})`);
  }
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[FATAL] no leí ${file}:`, e.message);
    process.exit(1);
  }
  for (const t of list) {
    if (!t || t.id == null || !t.alias) { skipped++; continue; }
    const alias = String(t.alias).trim().toLowerCase();
    const r = await db.addDest(Number(t.id), ownerId, alias, t.type || 'group', t.name || alias);
    if (r.ok) { done++; console.log(`[OK] ${alias} -> ${t.id}`); }
    else { skipped++; console.log(`[SKIP] ${alias} (${r.reason})`); }
  }
  console.log(`\nListo: ${done} destinos, ${skipped} omitidos. Activa el plan con /activar ${ownerId} pro 365 (como admin).`);
  process.exit(0);
}

main().catch((e) => { console.error('[FATAL]', e.message); process.exit(1); });
