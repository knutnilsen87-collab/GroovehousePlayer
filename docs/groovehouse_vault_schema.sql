-- Groovehouse Vault — databaseskisse v0.1 (Supabase / Postgres)
-- Prinsipp: én Asset-tabell, alt annet henger på den.
-- Lyttere har IKKE Supabase-kontoer. De identifiseres via invitasjonstoken,
-- som valideres i en Edge Function som deler ut kortlevde signerte HLS-URL-er
-- og tar imot lyttehendelser. Kun Knut (admin) logger inn med Supabase Auth.

create extension if not exists pgcrypto;

-- ---------- Enums ----------
create type asset_kind     as enum ('track', 'set', 'demo', 'stem');
create type asset_status   as enum ('uploading', 'processing', 'ready', 'failed', 'archived');
create type access_tier    as enum ('inner', 'partner', 'supporter', 'teaser');
create type marker_kind    as enum ('chapter', 'highlight', 'drop', 'clip');
create type marker_source  as enum ('manual', 'catalog_match', 'live_log');
create type listen_event   as enum ('open', 'play', 'pause', 'seek', 'heartbeat', 'ended');

-- ---------- Kjernen ----------
create table assets (
  id            uuid primary key default gen_random_uuid(),
  artist_id     uuid,                         -- null = Groovehouse/Knut. Billig dør åpen for flere artister.
  kind          asset_kind   not null,
  status        asset_status not null default 'uploading',
  title         text         not null,
  version_label text,                         -- "Club Mix", "Live @ X", "v3"
  parent_id     uuid references assets(id),   -- demo -> ferdig låt, stem -> låt
  duration_ms   integer,
  bpm           numeric(5,2),
  musical_key   text,
  -- Filer (R2-nøkler, aldri offentlige URL-er)
  master_key    text,                         -- WAV, kald lagring, kun admin
  hls_key       text,                         -- playlist.m3u8-prefiks
  cover_key     text,
  analysis_key  text,                         -- JSON: bølgeform, energikurve, spektrum per tidssteg
  -- Tema beregnet ved opplasting (ikke i React ved avspilling)
  palette       jsonb,                        -- {"primary":"#..","secondary":"#..","onPrimary":"#..","source":"cover|fallback"}
  -- Sett-metadata
  performed_at  timestamptz,
  venue         text,
  created_at    timestamptz not null default now()
);
create index on assets (kind, status);

create table asset_markers (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references assets(id) on delete cascade,
  kind          marker_kind   not null,
  source        marker_source not null default 'manual',
  start_ms      integer not null,
  end_ms        integer,
  label         text,
  ref_asset_id  uuid references assets(id),   -- "her starter WOULD YOU RUN"
  confidence    real,                         -- for catalog_match
  confirmed     boolean not null default false,
  check (end_ms is null or end_ms > start_ms)
);
create index on asset_markers (asset_id, start_ms);

-- ---------- Drops og tilgang ----------
create table drops (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  title         text not null,
  tier          access_tier not null,
  theme_asset_id uuid references assets(id),  -- hvilket cover som styrer fargene
  opens_at      timestamptz,                  -- nedtelling
  expires_at    timestamptz,
  allow_download boolean not null default false,
  created_at    timestamptz not null default now()
);

create table drop_items (
  drop_id   uuid references drops(id) on delete cascade,
  asset_id  uuid references assets(id),
  position  smallint not null,
  primary key (drop_id, asset_id)
);

create table recipients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text,
  org        text,                            -- "Snapchat"
  created_at timestamptz not null default now()
);

create table invites (
  id           uuid primary key default gen_random_uuid(),
  drop_id      uuid not null references drops(id) on delete cascade,
  recipient_id uuid not null references recipients(id),
  token_hash   text unique not null,          -- lagre kun hash av lenketokenet
  max_devices  smallint not null default 2,   -- videresendt lenke = ny enhet = flagg
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create table invite_devices (
  id          uuid primary key default gen_random_uuid(),
  invite_id   uuid not null references invites(id) on delete cascade,
  device_hash text not null,
  user_agent  text,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  unique (invite_id, device_hash)
);

-- ---------- Lytteinnsikt ----------
create table listen_sessions (
  id         uuid primary key default gen_random_uuid(),
  invite_id  uuid references invites(id),     -- null = egen avspilling / teaser
  device_id  uuid references invite_devices(id),
  asset_id   uuid not null references assets(id),
  started_at timestamptz not null default now()
);

create table listen_events (
  id          bigserial primary key,
  session_id  uuid not null references listen_sessions(id) on delete cascade,
  event       listen_event not null,
  position_ms integer not null,
  to_ms       integer,                        -- for seek
  at          timestamptz not null default now()
);
create index on listen_events (session_id, at);

-- ---------- Klipp-maskinen ----------
create table clips (
  id         uuid primary key default gen_random_uuid(),
  asset_id   uuid not null references assets(id),
  marker_id  uuid references asset_markers(id),
  start_ms   integer not null,
  end_ms     integer not null,
  format     text not null default '1080x1920',
  status     asset_status not null default 'processing',
  video_key  text,
  created_at timestamptz not null default now()
);

-- ---------- RLS ----------
-- Alle tabeller: RLS på, kun admin-rollen har tilgang via klient.
-- Lyttere går utelukkende gjennom Edge Functions med service role,
-- som sjekker token_hash, revoked_at, expires_at, opens_at og max_devices.
alter table assets          enable row level security;
alter table asset_markers   enable row level security;
alter table drops           enable row level security;
alter table drop_items      enable row level security;
alter table recipients      enable row level security;
alter table invites         enable row level security;
alter table invite_devices  enable row level security;
alter table listen_sessions enable row level security;
alter table listen_events   enable row level security;
alter table clips           enable row level security;
-- Admin-policy settes når auth er på plass, f.eks.:
-- create policy admin_all on assets for all using (auth.jwt() ->> 'email' = '<admin-epost>');
