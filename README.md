# 🏈 QB Pick-Em

A survivor-style quarterback pick-em for your league:

- Each player picks **one QB per week** and scores that QB's fantasy points
  (**ESPN standard scoring**: 0.04/pass yd, 4/pass TD, −2 INT, 0.1/rush yd,
  6/rush TD, 2/two-pt, −2 fumble lost).
- Once you've used a QB, **you can't pick him again for the regular season**.
- The used-QB pool **resets for the playoffs** (Wild Card → Super Bowl).
- The site shows every QB's opponent, kickoff time, and an **ensemble of
  projections** (Rotowire via Sleeper + ESPN, optionally FantasyPros), with
  filters by team / availability / starters.

The frontend is plain HTML/JS served by **GitHub Pages**. Picks are stored in
a free **Supabase** table so everyone can update picks all week. A **GitHub
Actions cron** refreshes rosters, schedules, projections, and pulls in final
scores automatically.

## Setup (one time, ~15 minutes)

### 1. Edit your league

Open [js/config.js](js/config.js) and set `PLAYERS` to your league members'
names and `LEAGUE_NAME` to whatever you call the league.

### 2. Create the Supabase backend (free)

1. Create a project at [supabase.com](https://supabase.com) (free tier).
2. In the dashboard, open **SQL Editor → New query**, paste the contents of
   [supabase/schema.sql](supabase/schema.sql), and click **Run**.
3. Go to **Project Settings → API** and copy:
   - the **Project URL** into `SUPABASE_URL` in `js/config.js`
   - the **anon public** key into `SUPABASE_ANON_KEY`

Until you do this, the site runs in *demo mode* (picks save only in each
visitor's own browser).

> The anon key is designed to be public — it only allows what the row-level
> security policies in `schema.sql` allow. This league is honor-system: anyone
> with the URL can enter/change picks under any name.

### 3. Push to GitHub and enable Pages

```bash
git remote add origin git@github.com:YOUR_USER/YOUR_REPO.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch →
Branch: `main` / root**. Your site appears at
`https://YOUR_USER.github.io/YOUR_REPO/` a minute later.

Also check **Settings → Actions → General → Workflow permissions** is set to
**Read and write permissions** so the data workflow can commit.

### 4. That's it

The [update workflow](.github/workflows/update-data.yml) runs daily at 10:00
UTC (plus Mon/Tue early runs to catch Sunday/Monday night finals). It:

- refreshes active rosters from Sleeper,
- refreshes the schedule/kickoffs from ESPN,
- rebuilds the projection ensemble for the current week,
- recomputes actual fantasy points for every completed week,

and commits the results to `data/`, which redeploys the Pages site. You can
also trigger it manually from the **Actions** tab (**Run workflow**).

### Optional: add FantasyPros to the ensemble

Get a free API key from
[fantasypros.com/apis](https://www.fantasypros.com/apis/) and add it as a
repo secret named `FANTASYPROS_API_KEY` (**Settings → Secrets and variables →
Actions**). The next data run will include it as a third projection source.

## How picking works

- Select your name in the top-right (remembered per browser).
- Pick any QB whose game hasn't kicked off. You can change or remove your pick
  freely **until your chosen QB's game starts** — then it's locked.
- QBs you've already used are greyed out (`USED · WEEK N`); toggle
  **Available only** off to see them. Chips show who else picked a QB this
  week (duplicate picks between players are allowed).
- **Standings** tab: season totals (regular + playoffs) and the full weekly
  pick matrix.

## Running data updates locally

```bash
python3 scripts/update_data.py
python3 scripts/update_scores.py
```

Both use only the Python standard library. Preview the site locally with:

```bash
python3 -m http.server 8000
```

## Notes / January to-do

- ESPN publishes weekly projections closer to kickoff; until then the ensemble
  may show Rotowire only. The scripts pick up new sources automatically.
- Playoff week mapping (`P1`–`P4`) in `scripts/update_scores.py` assumes
  Sleeper postseason weeks 1–4. Sleeper has shifted Super Bowl numbering in
  some past seasons — sanity-check the Wild Card scores in January.
