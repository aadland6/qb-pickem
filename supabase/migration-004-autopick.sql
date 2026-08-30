-- Migration 004: mark picks that were auto-assigned (player missed the
-- Sunday deadline and received a deterministic random QB).

alter table picks add column if not exists auto boolean not null default false;
