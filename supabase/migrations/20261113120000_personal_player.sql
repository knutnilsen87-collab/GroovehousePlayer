-- Groovehouse Vault – din egen spiller
--  * variant: samtidige varianter (Extended, Radio Edit, VIP Dub) skilt fra versjon over tid (_vN)
--  * camelot + sikkerhet for BPM/toneart fra ingest-analysen
--  * playback_positions: «fortsett der du slapp» på tvers av PC og mobil (erstatter localStorage i fase 2)

alter table assets add column variant text check (variant is null or variant ~ '^[a-z0-9][a-z0-9-]*$');
alter table assets add column variant_label text;
alter table assets add column camelot text check (camelot is null or camelot ~ '^(1[0-2]|[1-9])[AB]$');
alter table assets add column bpm_confidence real;
alter table assets add column key_confidence real;

-- Unik per slug + variant + versjon (null-variant = hovedversjon)
alter table assets drop constraint assets_slug_version_key;
create unique index assets_slug_variant_version on assets (slug, coalesce(variant, ''), version);

create table playback_positions (
  user_id     uuid not null,
  asset_slug  text not null,
  variant     text not null default '',   -- '' = hovedversjon; følger låta på tvers av nye versjoner
  position_ms integer not null check (position_ms >= 0),
  device      text,
  updated_at  timestamptz not null default now(),
  primary key (user_id, asset_slug, variant)
);

alter table playback_positions enable row level security;
-- Hver innlogget bruker ser og skriver bare sine egne posisjoner
create policy own_positions on playback_positions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
