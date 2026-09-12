-- Schema multi-tenant para telegram-mirror-bot (Supabase Postgres).
-- Correr en Supabase Dashboard -> SQL Editor -> New query -> pegar y Run.
-- El backend usa la service_role (bypasea RLS). RLS queda activado sin
-- politicas publicas: nadie accede desde el cliente.

-- 1. Dueños (clientes). user_id = Telegram user.id del que hizo /start.
create table if not exists owners (
  user_id    bigint primary key,
  plan       text not null default 'free' check (plan in ('free', 'pro')),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

-- 2. Codigos de vinculacion VINC-XXXX (15 min de vida).
create table if not exists link_codes (
  code       text primary key,
  user_id    bigint not null references owners(user_id) on delete cascade,
  expires_at timestamptz not null,
  used       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_link_codes_user on link_codes(user_id);

-- 3. Grupos/canales. Un chat solo puede ser ORIGEN de un dueño
-- (indice parcial), pero puede ser DESTINO de varios (canal compartido).
create table if not exists groups (
  chat_id    bigint not null,
  owner_id   bigint not null references owners(user_id) on delete cascade,
  role       text not null check (role in ('origen', 'destino')),
  alias      text,
  type       text not null default 'group',
  name       text,
  created_at timestamptz not null default now(),
  primary key (chat_id, owner_id, role),
  unique (owner_id, alias)
);
create unique index if not exists uniq_origin_chat
  on groups(chat_id) where role = 'origen';

-- 4. Log de envios (cuotas Free/Pro + estadistica por cliente).
create table if not exists fanout_log (
  id          bigserial primary key,
  owner_id    bigint not null references owners(user_id) on delete cascade,
  source_chat bigint not null,
  dest_total  int not null,
  dest_ok     int not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_fanout_owner_day
  on fanout_log(owner_id, created_at);

-- 5. Bloqueo total de acceso cliente: solo service_role (backend).
alter table owners     enable row level security;
alter table link_codes enable row level security;
alter table groups     enable row level security;
alter table fanout_log enable row level security;
-- Sin policies: anon/authenticated no ven ni tocan nada.
