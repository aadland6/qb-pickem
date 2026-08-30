-- Migration 002: exclusive QBs with allocation auctions.
--  * A QB may be contested (several players pick him the same week), so the
--    "one QB per player per phase" unique constraint moves to app logic based
--    on auction outcomes (losing an auction does NOT use up the QB).
--  * bid: allocation points wagered on this pick (0-100, from a single
--    100-point season-long budget; only a contested winner spends them).
--  * backup_*: fallback QB that activates automatically on an auction loss.
--  * claimed_at: when this QB was first claimed (auction tie-breaker).

alter table picks drop constraint if exists picks_player_name_season_phase_qb_id_key;

alter table picks add column if not exists bid int not null default 0
  check (bid >= 0 and bid <= 100);
alter table picks add column if not exists backup_qb_id text;
alter table picks add column if not exists backup_qb_name text;
alter table picks add column if not exists backup_qb_team text;
alter table picks add column if not exists claimed_at timestamptz not null default now();
