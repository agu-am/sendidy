// Acceso a Supabase Postgres via pooler (DATABASE_URL, puerto 6543).
// Usa la service_role: RLS bloquea todo acceso cliente, el backend pasa.
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;
  const url = (process.env.DATABASE_URL || '').trim();
  if (!url) {
    throw new Error('Falta DATABASE_URL en .env (Supabase → Connect → Transaction pooler, puerto 6543)');
  }
  pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 5 });
  pool.on('error', (e) => console.error('[db] pool error:', e.message));
  return pool;
}

async function ping() {
  await getPool().query('select 1 as ok');
}

async function getOwner(userId) {
  const { rows } = await getPool().query('select * from owners where user_id = $1', [userId]);
  return rows[0] || null;
}

// Plan efectivo: un Pro vencido cuenta como free (sin borrar la fila).
function effectivePlan(owner) {
  if (!owner) return 'free';
  if (owner.plan === 'pro') {
    if (!owner.expires_at) return 'pro'; // sin vencimiento = vitalicio
    if (new Date(owner.expires_at) > new Date()) return 'pro';
    return 'free';
  }
  return 'free';
}

async function ensureOwner(userId) {
  await getPool().query(
    "insert into owners(user_id, plan) values ($1, 'free') on conflict (user_id) do nothing",
    [userId]
  );
  return getOwner(userId);
}

async function setPlan(userId, plan, days) {
  await ensureOwner(userId);
  let expires = null;
  if (days && Number(days) > 0) {
    expires = new Date(Date.now() + Number(days) * 86400000).toISOString();
  }
  const { rows } = await getPool().query(
    'update owners set plan = $2, expires_at = $3 where user_id = $1 returning *',
    [userId, plan, expires]
  );
  return rows[0];
}

async function createLinkCode(userId, ttlMin = 15) {
  const { genLinkCode } = require('./util');
  const expires = new Date(Date.now() + ttlMin * 60000).toISOString();
  for (let i = 0; i < 5; i++) {
    const code = genLinkCode();
    try {
      await getPool().query(
        'insert into link_codes(code, user_id, expires_at) values ($1, $2, $3)',
        [code, userId, expires]
      );
      return { code, expires };
    } catch (e) {
      if (e.code !== '23505') throw e; // colision de codigo: reintenta
    }
  }
  throw new Error('No pude generar codigo, reintenta');
}

async function consumeLinkCode(code) {
  const clean = String(code || '').trim().toUpperCase();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      "select * from link_codes where code = $1 and used = false and expires_at > now() for update",
      [clean]
    );
    const row = rows[0];
    if (!row) {
      await client.query('rollback');
      return null;
    }
    await client.query('update link_codes set used = true where code = $1', [clean]);
    await client.query('commit');
    return row;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Vincula un chat como ORIGEN de un dueño. Falla si ya es origen de otro.
async function linkOrigin(chatId, ownerId, name, type) {
  const ex = await getPool().query(
    "select owner_id from groups where chat_id = $1 and role = 'origen'",
    [chatId]
  );
  if (ex.rows[0]) {
    return ex.rows[0].owner_id === Number(ownerId)
      ? { ok: false, reason: 'ya_vinculado_propio' }
      : { ok: false, reason: 'vinculado_otro' };
  }
  await getPool().query(
    "insert into groups(chat_id, owner_id, role, type, name) values ($1, $2, 'origen', $3, $4)",
    [chatId, ownerId, type || 'group', name || String(chatId)]
  );
  return { ok: true };
}

async function getOriginOwner(chatId) {
  const { rows } = await getPool().query(
    `select g.owner_id, g.name, o.plan, o.expires_at
       from groups g join owners o on o.user_id = g.owner_id
      where g.chat_id = $1 and g.role = 'origen'`,
    [chatId]
  );
  return rows[0] || null;
}

async function addDest(chatId, ownerId, alias, type, name) {
  try {
    await getPool().query(
      "insert into groups(chat_id, owner_id, role, alias, type, name) values ($1, $2, 'destino', $3, $4, $5)",
      [chatId, ownerId, alias, type || 'group', name || alias]
    );
    return { ok: true };
  } catch (e) {
    if (e.code === '23505') return { ok: false, reason: 'alias_duplicado' };
    throw e;
  }
}

async function listGroups(ownerId, role) {
  const { rows } = await getPool().query(
    'select chat_id as id, alias, type, name from groups where owner_id = $1 and role = $2 order by created_at',
    [ownerId, role]
  );
  return rows.map((r, i) => ({ ...r, id: Number(r.id), index: i + 1 }));
}

async function countDests(ownerId) {
  const { rows } = await getPool().query(
    "select count(*)::int as n from groups where owner_id = $1 and role = 'destino'",
    [ownerId]
  );
  return rows[0].n;
}

async function removeDest(ownerId, ref) {
  const s = String(ref).trim().toLowerCase();
  const { rowCount } = await getPool().query(
    "delete from groups where owner_id = $1 and role = 'destino' and (lower(alias) = $2 or chat_id::text = $2)",
    [ownerId, s]
  );
  return rowCount > 0;
}

async function logFanout(ownerId, sourceChat, total, ok) {
  await getPool().query(
    'insert into fanout_log(owner_id, source_chat, dest_total, dest_ok) values ($1, $2, $3, $4)',
    [ownerId, sourceChat, total, ok]
  ).catch((e) => console.error('[db] logFanout:', e.message));
}

async function countToday(ownerId) {
  const { rows } = await getPool().query(
    "select count(*)::int as n from fanout_log where owner_id = $1 and created_at > now() - interval '24 hours'",
    [ownerId]
  );
  return rows[0].n;
}

async function getStats(ownerId) {
  const pool = getPool();
  const [{ rows: rc }, { rows: [today] }, { rows: [w7] }, { rows: [m30] }, { rows: recent }] = await Promise.all([
    pool.query("select role, count(*)::int as n from groups where owner_id = $1 group by role", [ownerId]),
    pool.query("select count(*)::int as sends from fanout_log where owner_id = $1 and created_at > now() - interval '24 hours'", [ownerId]),
    pool.query("select count(*)::int as sends, coalesce(sum(dest_total),0)::int as copies, coalesce(sum(dest_ok),0)::int as ok from fanout_log where owner_id = $1 and created_at > now() - interval '7 days'", [ownerId]),
    pool.query("select count(*)::int as sends, coalesce(sum(dest_total),0)::int as copies, coalesce(sum(dest_ok),0)::int as ok from fanout_log where owner_id = $1 and created_at > now() - interval '30 days'", [ownerId]),
    pool.query("select source_chat, dest_total, dest_ok, created_at from fanout_log where owner_id = $1 order by id desc limit 10", [ownerId]),
  ]);
  const byRole = Object.fromEntries(rc.map((r) => [r.role, r.n]));
  return {
    origins: byRole.origen || 0,
    dests: byRole.destino || 0,
    today: today.sends,
    w7, m30,
    recent: recent.map((r) => ({ ...r, source_chat: Number(r.source_chat) })),
  };
}

async function exportOwner(ownerId) {
  const owner = await getOwner(ownerId);
  const origins = await listGroups(ownerId, 'origen');
  const dests = await listGroups(ownerId, 'destino');
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    owner: owner ? { user_id: Number(owner.user_id), plan: owner.plan, expires_at: owner.expires_at } : { user_id: Number(ownerId) },
    origins: origins.map((o) => ({ chat_id: o.id, type: o.type, name: o.name })),
    dests: dests.map((d) => ({ chat_id: d.id, alias: d.alias, type: d.type, name: d.name })),
  };
}

async function exportAll() {
  const { rows: owners } = await getPool().query('select user_id from owners order by user_id');
  const out = { version: 1, exported_at: new Date().toISOString(), owners: [] };
  for (const o of owners) out.owners.push(await exportOwner(Number(o.user_id)));
  return out;
}

// Reimporta un backup propio. Respeta topes del plan y no pisa otros dueños.
async function importOwnerData(ownerId, data, maxDests) {
  const res = { originsOk: 0, originsSkipped: [], destsOk: 0, destsSkipped: [] };
  for (const o of data.origins || []) {
    if (!Number.isFinite(Number(o.chat_id))) { res.originsSkipped.push(`${o.chat_id}: id inválido`); continue; }
    const r = await linkOrigin(Number(o.chat_id), ownerId, o.name || String(o.chat_id), o.type === 'channel' ? 'channel' : 'group');
    if (r.ok) res.originsOk++;
    else res.originsSkipped.push(`${o.chat_id}: ${r.reason === 'vinculado_otro' ? 'origen de otro dueño' : 'ya vinculado'}`);
  }
  for (const d of data.dests || []) {
    const alias = String(d.alias || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{2,24}$/.test(alias) || !Number.isFinite(Number(d.chat_id))) {
      res.destsSkipped.push(`${d.alias || d.chat_id}: dato inválido`);
      continue;
    }
    if ((await countDests(ownerId)) >= maxDests) {
      res.destsSkipped.push(`${alias}: tope del plan (${maxDests})`);
      continue;
    }
    const r = await addDest(Number(d.chat_id), ownerId, alias, d.type === 'channel' ? 'channel' : 'group', d.name || alias);
    if (r.ok) res.destsOk++;
    else res.destsSkipped.push(`${alias}: alias en uso`);
  }
  return res;
}

module.exports = {
  ping, getOwner, effectivePlan, ensureOwner, setPlan,
  createLinkCode, consumeLinkCode, linkOrigin, getOriginOwner,
  addDest, listGroups, countDests, removeDest, logFanout, countToday,
  getStats, exportOwner, exportAll, importOwnerData,
  getPool,
};
