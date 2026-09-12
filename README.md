# Telegram Mirror Bot — multi-tenant con planes (webhook + Supabase)

Cada cliente vincula SU grupo origen y SUS destinos con `/vincular`. Nada se mezcla: todo filtra por dueño. Planes **Free** (1 origen + 3 destinos + 30 envíos/día) y **Pro** (50 destinos + `/enviar_varios` + directos + 1000/día). Cobro manual con `/activar`.

## Comandos

En grupo vinculado (solo admins, citando un mensaje):
- `/enviar` → a TODOS tus destinos
- `/enviar_a <alias|ID|nº>` → a 1 (ej: `/enviar_a vip`, `/enviar_a -100...`, `/enviar_a 5`, Pro: `/enviar_a @micanal`)
- `/enviar_varios <a,b,c>` → a varios (solo Pro)
- `/vincular VINC-XXXX` → hace este grupo tu origen · `/misgrupos` · `/plan` · `/quitar` · `/id`

En privado: `/start` (da tu código), `/agregar <ID> <alias>`, `/misgrupos`, `/plan`, `/stats`, `/backup`, `/restore` (citando el .json), `/id`. Admin: `/activar`, `/backup_all`.
En destino (grupo/canal donde está el bot): `/agregar <alias>`.
En canales solo funciona `/id` (luego borra esos mensajes, son visibles).
Admin del servicio: `/activar <user_id> <free|pro> [dias]`.

## 0. Supabase (una vez)

1. Supabase.com → New project (región São Paulo o US-East) → guarda password.
2. SQL Editor → New query → pega `supabase/schema.sql` → Run (crea `owners`, `link_codes`, `groups`, `fanout_log` con RLS bloqueado).
3. Connect → **Transaction pooler** (puerto 6543, modo Session) → copia la connection string y ponla en `DATABASE_URL` (reemplaza `[YOUR-PASSWORD]` con URL-encoding si tiene símbolos).

## 1. GitHub (una vez)

```powershell
cd C:\Users\Agustin\projects\telegram-mirror-bot
git init; git add -A; git commit -m "mirror bot webhook multi-tenant"
gh repo create telegram-mirror-bot --private --source=. --push
# sin gh CLI: crea el repo privado en github.com y luego:
# git remote add origin https://github.com/TUUSER/telegram-mirror-bot.git; git push -u origin main
```

## 2. Local por webhook (ngrok)

```powershell
copy .env.example .env   # si no existe; completa BOT_TOKEN, ADMIN_IDS, DATABASE_URL
# secreto: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
npm install
ngrok http 3000          # otra terminal; copia la URL https
# .env → WEBHOOK_URL=https://xxx.ngrok-free.app
npm run dev              # auto setWebhook al arrancar
```

## 3. Render (prod)

1. Dashboard → New → Web Service → conecta el repo (usa `render.yaml`: build `npm ci`, start `node src/server.js`, health `/health`).
2. Environment: `BOT_TOKEN`, `WEBHOOK_URL=https://tu-app.onrender.com`, `DATABASE_URL`, `ADMIN_IDS`. `WEBHOOK_SECRET` se autogenera (o pon el tuyo).
3. Deploy → log debe mostrar `[OK] Supabase conectado` + `[OK] setWebhook`.
4. UptimeRobot gratis: monitor HTTP(S) a `https://tu-app.onrender.com/health` cada 5 min (anti-sleep + alerta de caída).

## 4. Migrar tus grupos actuales (una vez, con Supabase listo)

```powershell
$env:IMPORT_ORIGIN_ID="-100tuorigen"
node scripts/import_targets.js <tu_user_id> targets.json
# en Telegram (como admin del servicio): /activar <tu_user_id> pro 365
```

Luego el flujo normal por cliente: privado `/start` → código → en su grupo `/vincular CODIGO` → en cada destino `/agregar <alias>`.

## Notas que siguen valiendo del bot original

- BotFather: `/setprivacy` Disable (+re-agregar a grupos), `/setjoingroups` Enable.
- En **canales el bot debe ser admin con Publicar mensajes** (si no: `need administrator rights`).
- `copyMessage` llega idéntico sin "reenviado"; polls/servicio usan `forward` como fallback.
- Un Pro financia el Render Starter (~$7/mes) y te olvidas del sleep. Free de Render + pinger para el MVP.
- `npm run selftest` corre 6 checks de lógica pura.
