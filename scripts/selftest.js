// Self-test de helpers puros: node scripts/selftest.js
const assert = require('node:assert/strict');
const { splitList, argsAfterCommand, genLinkCode, resolveInList, hintFor, formatStats, validateBackup } = require('../src/util');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`ok ${n} - ${name}`); };

t('splitList coma/espacio/punto-coma', () => {
  assert.deepEqual(splitList('vip,ventas canal1;otro'), ['vip', 'ventas', 'canal1', 'otro']);
  assert.deepEqual(splitList(''), []);
});

t('argsAfterCommand con y sin @bot', () => {
  assert.equal(argsAfterCommand('/enviar_a vip'), 'vip');
  assert.equal(argsAfterCommand('/enviar_a@MiBot vip,ventas'), 'vip,ventas');
  assert.equal(argsAfterCommand('/enviar'), '');
});

t('genLinkCode formato VINC-XXXX sin ambiguos', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = genLinkCode();
    assert.match(c, /^VINC-[A-Z2-9]{4}$/);
    assert.ok(!/[01IO]/.test(c.split('-')[1]));
    seen.add(c);
  }
  assert.ok(seen.size > 190, 'colisiones sospechosas');
});

const dests = [
  { id: -100111, alias: 'vip', name: 'VIP', type: 'group', index: 1 },
  { id: -100222, alias: 'ventas', name: 'Ventas', type: 'group', index: 2 },
];

t('resolveInList alias/ID/indice', () => {
  assert.equal(resolveInList('vip', dests).dest.alias, 'vip');
  assert.equal(resolveInList('VIP', dests).dest.alias, 'vip');
  assert.equal(resolveInList('-100222', dests).dest.alias, 'ventas');
  assert.equal(resolveInList('2', dests).dest.alias, 'ventas');
  assert.equal(resolveInList('99', dests), null);
  assert.equal(resolveInList('nada', dests), null);
});

t('resolveInList directos (solo metadata, el gate es de bot.js)', () => {
  const d1 = resolveInList('-100999', dests);
  assert.equal(d1.kind, 'direct'); assert.equal(d1.id, '-100999');
  const d2 = resolveInList('@micanal', dests);
  assert.equal(d2.kind, 'direct'); assert.equal(d2.id, '@micanal');
  assert.equal(resolveInList('@vip', dests).kind, 'listed'); // alias gana
});

t('hintFor traduce causas comunes', () => {
  assert.match(hintFor('c1', 'Bad Request: need administrator rights in the channel chat'), /NO es admin/);
  assert.match(hintFor('c1', 'Bad Request: chat not found'), /ID incorrecto/);
  assert.match(hintFor('c1', 'Conflict: terminated by other getUpdates request'), /Conflict/);
});

t('formatStats arma el resumen', () => {
  const out = formatStats({
    plan: 'pro', expires: '12/3/2026', origins: 1, dests: 42, maxDests: 50,
    todaySends: 5, todayCap: 1000,
    w7: { sends: 20, copies: 1000, ok: 980 },
    m30: { sends: 60, copies: 3000, ok: 2900 },
    recent: [{ created_at: '2026-09-12T14:03:00Z', dest_ok: 50, dest_total: 50 }],
  });
  assert.match(out, /Plan pro/);
  assert.match(out, /Destinos: 42\/50/);
  assert.match(out, /980\/1000 copias \(98%\)/);
  const empty = formatStats({
    plan: 'free', expires: null, origins: 0, dests: 0, maxDests: 3,
    todaySends: 0, todayCap: 30,
    w7: { sends: 0, copies: 0, ok: 0 }, m30: { sends: 0, copies: 0, ok: 0 }, recent: [],
  });
  assert.match(empty, /Sin envíos todavía/);
});

t('validateBackup acepta y rechaza', () => {
  assert.equal(validateBackup({ version: 1, dests: [], origins: [] }).ok, true);
  assert.equal(validateBackup({ version: 2 }).ok, false);
  assert.equal(validateBackup(null).ok, false);
  assert.equal(validateBackup({ version: 1, dests: 'x' }).ok, false);
});

console.log(`\nSELFTEST OK (${n} casos)`);
