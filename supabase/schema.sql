-- QB Pick-Em schema. Run this once in the Supabase SQL editor
-- (Dashboard -> SQL Editor -> New query -> paste -> Run).

create table if not exists picks (
  id uuid primary key default gen_random_uuid(),
  player_name text not null,
  season int not null,
  phase text not null check (phase in ('regular', 'playoffs')),
  week_key text not null,          -- '1'..'18' or 'P1'..'P4'
  qb_id text not null,             -- Sleeper player id
  qb_name text not null,
  qb_team text not null,
  updated_at timestamptz not null default now(),

  -- one pick per player per week
  unique (player_name, season, phase, week_key),
  -- a QB can only be used once per player per phase (resets for playoffs)
  unique (player_name, season, phase, qb_id)
);

-- Honor-system league: the anon key may read and write picks.
alter table picks enable row level security;

create policy "anyone can read picks"   on picks for select using (true);
create policy "anyone can add picks"    on picks for insert with check (true);
create policy "anyone can change picks" on picks for update using (true);
create policy "anyone can remove picks" on picks for delete using (true);
