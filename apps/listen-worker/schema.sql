-- Del 13. Kilden i drift er listen_doc (samme poster som relasjonstabellene).
-- Relasjonstabellene er projeksjonen som kan spørres i D1.

create table if not exists listen_doc (
  id integer primary key check (id = 1),
  doc text not null
);

create table if not exists drops (
  id text primary key,
  title text not null,
  tier text not null,
  recipient text not null,
  expires_at text,
  max_devices integer not null,
  code_hash text,
  revoked_at text,
  token_hash text not null,
  created_at text not null
);

create table if not exists drop_items (
  drop_id text not null,
  slug text not null,
  variant text not null,
  version integer not null,
  title text not null,
  content_hash text not null,
  position integer not null,
  primary key (drop_id, slug, variant, version)
);

create table if not exists invite_devices (
  drop_id text not null,
  device_id text not null,
  user_agent text,
  first_seen text not null,
  last_seen text not null,
  primary key (drop_id, device_id)
);

create table if not exists listen_events (
  id integer primary key,
  drop_id text not null,
  device_id text not null,
  slug text not null,
  event text not null,
  position_ms integer not null,
  at text not null
);

create table if not exists access_requests (
  id text primary key,
  drop_id text not null,
  name text not null,
  at text not null,
  status text not null
);
