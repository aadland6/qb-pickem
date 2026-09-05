-- Migration 005: self-service league membership. The roster lives in a
-- `players` table instead of a hardcoded list; joining the league is just
-- inserting your name. Names can't be renamed or removed via the anon key
-- (no update/delete policies), so nobody can knock someone else out.

create table if not exists players (
  name text primary key check (length(trim(name)) between 1 and 24),
  joined_at timestamptz not null default now()
);

alter table players enable row level security;

do $$
begin
  create policy "anyone can read players" on players for select using (true);
exception when duplicate_object then null;
end $$;

do $$
begin
  create policy "anyone can join" on players for insert with check (true);
exception when duplicate_object then null;
end $$;

-- Broadcast roster changes so open tabs pick up new members instantly.
do $$
begin
  alter publication supabase_realtime add table players;
exception when duplicate_object then null;
end $$;

-- Seed the founding members (and Gabe, joining 2026).
insert into players (name)
values ('Luke'), ('Lucas'), ('Matt'), ('Cody'), ('Gabe')
on conflict (name) do nothing;
