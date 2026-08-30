// ---------------------------------------------------------------------------
// League configuration — EDIT THIS FILE for your league.
// ---------------------------------------------------------------------------

export const CONFIG = {
  // Paste your Supabase project URL + anon (public) key here after running
  // supabase/schema.sql. Until then the site runs in "demo mode" and saves
  // picks only in each visitor's browser (localStorage).
  SUPABASE_URL: "https://anabanpqrujkhhwxrkov.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFuYWJhbnBxcnVqa2hod3hya292Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwOTYyMTMsImV4cCI6MjEwMzY3MjIxM30.C7II-fgx5KYbKlcbksIsy0mzWRY4aXa-ZaITernyjOU",

  // Everyone in the league. Players pick their own name from a dropdown
  // (honor system — no passwords).
  PLAYERS: ["Luke", "Lucas", "Matt"],

  SEASON: 2026,
  LEAGUE_NAME: "QB Pick-Em",
};
