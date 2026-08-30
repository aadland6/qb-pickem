-- QB Pick-Em schema (canonical, for fresh installs — already-created projects
-- should run the migration-NNN files instead). Run in the Supabase SQL editor
-- or via scripts/apply_schema.py.

create table if not exists picks (
  id uuid primary key default gen_random_uuid(),
  player_name text not null,
  season int not null,
  phase text not null check (phase in ('regular', 'playoffs')),
  week_key text not null,          -- '1'..'18' or 'P1'..'P4'
  qb_id text not null,             -- Sleeper player id (primary pick)
  qb_name text not null,
  qb_team text not null,
  bid int not null default 0 check (bid >= 0 and bid <= 100),
  backup_qb_id text,               -- activates if the primary is lost at auction
  backup_qb_name text,
  backup_qb_team text,
  claimed_at timestamptz not null default now(),  -- auction tie-breaker
  updated_at timestamptz not null default now(),

  -- one pick row per player per week
  unique (player_name, season, phase, week_key)
  -- NOTE: no per-QB uniqueness — several players may contest the same QB;
  -- exclusivity is decided by the allocation auction at kickoff.
);

-- Honor-system league: the anon key may read and write picks.
alter table picks enable row level security;

create policy "anyone can read picks"   on picks for select using (true);
create policy "anyone can add picks"    on picks for insert with check (true);
create policy "anyone can change picks" on picks for update using (true);
create policy "anyone can remove picks" on picks for delete using (true);
