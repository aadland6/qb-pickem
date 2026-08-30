-- Migration 003: broadcast picks changes so open browsers update live
-- (contest alerts + instant standings refresh).

do $$
begin
  alter publication supabase_realtime add table picks;
exception
  when duplicate_object then null;  -- already added
end $$;
