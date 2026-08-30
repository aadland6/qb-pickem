// ---------------------------------------------------------------------------
// League configuration — EDIT THIS FILE for your league.
// ---------------------------------------------------------------------------

export const CONFIG = {
  // Paste your Supabase project URL + anon (public) key here after running
  // supabase/schema.sql. Until then the site runs in "demo mode" and saves
  // picks only in each visitor's browser (localStorage).
  SUPABASE_URL: "YOUR_SUPABASE_URL",
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_ANON_KEY",

  // Everyone in the league. Players pick their own name from a dropdown
  // (honor system — no passwords).
  PLAYERS: ["Luke", "Lucas", "Matt"],

  SEASON: 2026,
  LEAGUE_NAME: "QB Pick-Em",
};
