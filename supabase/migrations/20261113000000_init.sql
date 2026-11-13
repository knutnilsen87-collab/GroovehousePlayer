-- Groovehouse Vault – første migrasjon (fra groovehouse_vault_schema.sql v0.1)
--
-- Endringer mot skissen v0.1, og hvorfor:
--  * assets.slug + assets.version (+ unik på slug/version): mappekonvensjonen <slug>_v<N> fra ingest.
--  * assets.master_sha256 (unik): ingest er idempotent – samme master to ganger gir ikke duplikat.
--  * assets.artist, loudness-feltene, preview_key, cover_thumb_key: alt ingest-manifestet produserer.
--  * marker_source får 'analysis': forslag til DROP fra energianalysen (alltid confirmed = false).
--  * asset_markers.ref_slug: live-loggen kjenner bare slug, ikke asset-id, når settet ingestes.
--  * listen_events får indeks på (session_id, at) – brukt av computeCoverage().
--
-- Lyttere har IKKE Supabase-kontoer. De går via Edge Functions (service role) som sjekker
-- token_hash, revoked_at, opens_at/expires_at og max_devices. Kun admin har direkte tilgang.

create extension if not exists pgcrypto;

-- ---------- Enums ----------
create type asset_kind     as enum ('track', 'set', 'demo', 'stem');
create type asset_status   as enum ('uploading', 'processing', 'ready', 'failed', 'archived');
create type access_tier    as enum ('inner', 'partner', 'supporter', 'teaser');
create type marker_kind    as enum ('chapter', 'highlight', 'drop', 'clip');
create type marker_source  as enum ('manual', 'catalog_match', 'live_log', 'analysis');
create type listen_event   as enum ('open', 'play', 'pause', 'seek', 'heartbeat', 'ended');

-- ---------- Admin ----------
-- Hvem som er admin. Fyll inn din egen auth.users-id etter første innlogging:
--   insert into admins (user_id) values ('<din-uuid>');
create table admins (
  user_id uuid primary key
);

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

-- ---------- Kjernen ----------
create table assets (
  id              uuid primary key default gen_random_uuid(),
  artist_id       uuid,                          -- null = Groovehouse. Døra står åpen for flere artister.
  slug            text not null check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  version         integer not null default 1 check (version >= 1),
  kind            asset_kind   not null,
  status          asset_status not null default 'processing',
  title           text not null,
  artist          text,
  version_label   text,
  parent_id       uuid references assets(id),
  duration_ms     integer,
  sample_rate     integer,
  channels        smallint,
  bpm             numeric(5,2),
  musical_key     text,
  master_sha256   text unique,
  -- R2-nøkler, aldri offentlige URL-er
  master_key      text,
  hls_key         text,
  preview_key     text,
  cover_key       text,
  cover_thumb_key text,
  analysis_key    text,
  -- Lydnivå: masteren endres aldri, vi lagrer bare avspillingsgain
  integrated_lufs numeric(5,2),
  true_peak_dbtp  numeric(5,2),
  lra             numeric(5,2),
  playback_gain_db numeric(4,1),
  -- Tema beregnet ved opplasting
  palette         jsonb,                         -- {"primary","secondary","onPrimary","source"}
  performed_at    timestamptz,
  venue           text,
  created_at      timestamptz not null default now(),
  unique (slug, version)
);
create index on assets (kind, status);

create table asset_markers (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references assets(id) on delete cascade,
  kind          marker_kind   not null,
  source        marker_source not null default 'manual',
  start_ms      integer not null check (start_ms >= 0),
  end_ms        integer,
  label         text,
  ref_asset_id  uuid references assets(id),
  ref_slug      text,
  confidence    real,
  confirmed     boolean not null default false,
  check (end_ms is null or end_ms > start_ms)
);
create index on asset_markers (asset_id, start_ms);

-- ---------- Drops og tilgang ----------
create table drops (
  id             uuid primary key default gen_random_uuid(),
  slug           text unique not null check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  title          text not null,
  tier           access_tier not null,
  theme_asset_id uuid references assets(id),
  opens_at       timestamptz,
  expires_at     timestamptz,
  allow_download boolean not null default false,
  created_at     timestamptz not null default now(),
  check (expires_at is null or opens_at is null or expires_at > opens_at)
);

create table drop_items (
  drop_id  uuid references drops(id) on delete cascade,
  asset_id uuid references assets(id),
  position smallint not null,
  primary key (drop_id, asset_id)
);

create table recipients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text,
  org        text,
  created_at timestamptz not null default now()
);

create table invites (
  id           uuid primary key default gen_random_uuid(),
  drop_id      uuid not null references drops(id) on delete cascade,
  recipient_id uuid not null references recipients(id),
  token_hash   text unique not null,             -- kun hash av lenketokenet lagres
  max_devices  smallint not null default 2 check (max_devices >= 1),
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
  invite_id  uuid references invites(id),
  device_id  uuid references invite_devices(id),
  asset_id   uuid not null references assets(id),
  started_at timestamptz not null default now()
);

create table listen_events (
  id          bigserial primary key,
  session_id  uuid not null references listen_sessions(id) on delete cascade,
  event       listen_event not null,
  position_ms integer not null,
  to_ms       integer,
  at          timestamptz not null default now()
);
create index on listen_events (session_id, at);

-- ---------- Klipp-maskinen ----------
create table clips (
  id         uuid primary key default gen_random_uuid(),
  asset_id   uuid not null references assets(id),
  marker_id  uuid references asset_markers(id),
  start_ms   integer not null,
  end_ms     integer not null check (end_ms > start_ms),
  format     text not null default '1080x1920',
  status     asset_status not null default 'processing',
  video_key  text,
  created_at timestamptz not null default now()
);

-- ---------- RLS: alt låst, kun admin ----------
do $$
declare t text;
begin
  foreach t in array array['admins','assets','asset_markers','drops','drop_items','recipients','invites',
                           'invite_devices','listen_sessions','listen_events','clips']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy admin_all on %I for all to authenticated using (is_admin()) with check (is_admin())', t);
  end loop;
end $$;
