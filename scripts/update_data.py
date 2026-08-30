#!/usr/bin/env python3
"""Refresh rosters, schedule, and projections for the QB pick-em site.

Writes:
  data/qbs.json          - active NFL quarterbacks (from Sleeper's player dump)
  data/schedule.json     - full-season schedule with kickoff times (from ESPN)
  data/projections.json  - ensemble weekly projections (ESPN + Rotowire-via-Sleeper,
                           plus FantasyPros if FANTASYPROS_API_KEY is set)
  data/meta.json         - season / current-week metadata

Uses only the Python standard library so it runs anywhere (incl. GitHub Actions)
with no pip install.
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SEASON = int(os.environ.get("PICKEM_SEASON", "2026"))
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# ESPN standard scoring (QB-relevant categories)
SCORING = {
    "pass_yd": 0.04,
    "pass_td": 4.0,
    "pass_int": -2.0,
    "pass_2pt": 2.0,
    "rush_yd": 0.1,
    "rush_td": 6.0,
    "rush_2pt": 2.0,
    "fum_lost": -2.0,
}

# ESPN fantasy stat-id -> our stat key
ESPN_STAT_IDS = {
    "3": "pass_yd",
    "4": "pass_td",
    "19": "pass_2pt",
    "20": "pass_int",
    "24": "rush_yd",
    "25": "rush_td",
    "26": "rush_2pt",
    "72": "fum_lost",
}

# Playoff week keys used across the app. ESPN seasontype 3 week numbers:
# 1=Wild Card, 2=Divisional, 3=Conference, 4=Pro Bowl (skipped), 5=Super Bowl.
PLAYOFF_WEEKS = {1: "P1", 2: "P2", 3: "P3", 5: "P4"}
PLAYOFF_LABELS = {"P1": "Wild Card", "P2": "Divisional", "P3": "Conference", "P4": "Super Bowl"}


def fetch_json(url, headers=None, timeout=60):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": "curl/8.1.2"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def std_points(stats):
    return round(sum(float(stats.get(k, 0) or 0) * w for k, w in SCORING.items()), 2)


# ---------------------------------------------------------------- rosters ---

def build_qbs():
    print("Fetching Sleeper player dump (large, ~15MB)...")
    players = fetch_json("https://api.sleeper.app/v1/players/nfl", timeout=180)
    qbs = []
    for pid, p in players.items():
        if p.get("position") != "QB" or not p.get("team") or not p.get("active"):
            continue
        qbs.append({
            "id": pid,
            "espn_id": p.get("espn_id"),
            "name": p.get("full_name") or f"{p.get('first_name','')} {p.get('last_name','')}".strip(),
            "team": p["team"],
            "number": p.get("number"),
            "depth": p.get("depth_chart_order") or 99,
            "injury": p.get("injury_status"),
            "exp": p.get("years_exp"),
        })
    qbs.sort(key=lambda q: (q["team"], q["depth"], q["name"]))
    print(f"  {len(qbs)} active QBs")
    return qbs


# --------------------------------------------------------------- schedule ---

def fetch_week_games(seasontype, week):
    url = (f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
           f"?dates={SEASON}&seasontype={seasontype}&week={week}")
    data = fetch_json(url)
    games = []
    for ev in data.get("events", []):
        comp = ev.get("competitions", [{}])[0]
        home = away = None
        for c in comp.get("competitors", []):
            # normalize to Sleeper abbreviations (only WSH differs)
            abbr = c.get("team", {}).get("abbreviation")
            abbr = {"WSH": "WAS"}.get(abbr, abbr)
            if c.get("homeAway") == "home":
                home = abbr
            else:
                away = abbr
        if home and away:
            game = {
                "home": home,
                "away": away,
                "kickoff": ev.get("date"),
                "espn_game_id": ev.get("id"),
                "status": ev.get("status", {}).get("type", {}).get("name"),
            }
            # Late-season/flex games carry placeholder times until the NFL
            # sets them; ESPN marks these timeValid=false. The app must not
            # lock or resolve picks against a placeholder kickoff.
            if comp.get("timeValid") is False:
                game["tbd"] = True
            games.append(game)
    return games


def build_schedule():
    weeks = {}
    for w in range(1, 19):
        games = fetch_week_games(2, w)
        weeks[str(w)] = {"label": f"Week {w}", "phase": "regular", "games": games}
        print(f"  Week {w}: {len(games)} games")
    for espn_w, key in PLAYOFF_WEEKS.items():
        games = fetch_week_games(3, espn_w)
        weeks[key] = {"label": PLAYOFF_LABELS[key], "phase": "playoffs", "games": games}
        print(f"  {PLAYOFF_LABELS[key]}: {len(games)} games")
    return {"season": SEASON, "weeks": weeks}


def current_week(schedule):
    """First week whose last kickoff hasn't finished (+6h grace) yet."""
    now = datetime.now(timezone.utc)
    order = [str(w) for w in range(1, 19)] + ["P1", "P2", "P3", "P4"]
    for key in order:
        games = schedule["weeks"].get(key, {}).get("games", [])
        if not games:
            continue
        last = max(datetime.fromisoformat(g["kickoff"].replace("Z", "+00:00")) for g in games)
        if (now - last).total_seconds() < 6 * 3600:
            return key
    return order[0]


# ------------------------------------------------------------ projections ---

def sleeper_projections(week_key):
    """Rotowire projections served by Sleeper. Returns {sleeper_id: {stats, opponent}}."""
    if week_key.startswith("P"):
        season_type, week = "post", {"P1": 1, "P2": 2, "P3": 3, "P4": 4}[week_key]
    else:
        season_type, week = "regular", int(week_key)
    url = (f"https://api.sleeper.com/projections/nfl/{SEASON}/{week}"
           f"?season_type={season_type}&position%5B%5D=QB&order_by=pts_std")
    out = {}
    try:
        for row in fetch_json(url):
            stats = row.get("stats") or {}
            if not stats:
                continue
            out[row["player_id"]] = {
                "pts": std_points(stats),
                "opponent": row.get("opponent"),
            }
    except Exception as e:  # noqa: BLE001 - source outage shouldn't kill the run
        print(f"  WARNING: sleeper projections failed: {e}", file=sys.stderr)
    return out


def espn_projections(week_key, espn_to_sleeper):
    """ESPN weekly projections. Returns {sleeper_id: pts} (ESPN-standard scoring)."""
    if week_key.startswith("P"):
        # ESPN fantasy scoring periods for playoffs continue 19, 20, 21, 22
        period = {"P1": 19, "P2": 20, "P3": 21, "P4": 22}[week_key]
    else:
        period = int(week_key)
    proj_id = f"11{SEASON}{period}"  # statSourceId=1 (projection), split=1 (weekly)
    flt = {
        "players": {
            "filterSlotIds": {"value": [0]},  # QB slot
            "filterStatsForExternalIds": {"value": [SEASON]},
            "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
            "limit": 120,
            "filterRanksForScoringPeriodIds": {"value": [period]},
            "filterStatsForTopScoringPeriodIds": {"value": 2, "additionalValue": [f"00{SEASON}", f"10{SEASON}", proj_id]},
        }
    }
    url = (f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{SEASON}"
           f"/segments/0/leaguedefaults/3?scoringPeriodId={period}&view=kona_player_info")
    out = {}
    try:
        data = fetch_json(url, headers={"User-Agent": "curl/8.1.2",
                                        "X-Fantasy-Filter": json.dumps(flt)})
        for entry in data.get("players", []):
            player = entry.get("player") or {}
            sleeper_id = espn_to_sleeper.get(str(player.get("id")))
            if not sleeper_id:
                continue
            for stat in player.get("stats", []):
                if stat.get("id") != proj_id:
                    continue
                raw = stat.get("stats") or {}
                mapped = {ours: raw.get(eid, 0) for eid, ours in ESPN_STAT_IDS.items()}
                pts = std_points(mapped) if any(mapped.values()) else round(stat.get("appliedTotal", 0), 2)
                if pts:
                    out[sleeper_id] = pts
    except Exception as e:  # noqa: BLE001
        print(f"  WARNING: espn projections failed: {e}", file=sys.stderr)
    return out


def fantasypros_projections(week_key, qbs_by_name):
    """Optional third source; needs FANTASYPROS_API_KEY. Returns {sleeper_id: pts}."""
    key = os.environ.get("FANTASYPROS_API_KEY")
    if not key or week_key.startswith("P"):
        return {}
    url = (f"https://api.fantasypros.com/public/v2/json/nfl/{SEASON}"
           f"/projections?position=QB&week={week_key}&scoring=STD")
    out = {}
    try:
        data = fetch_json(url, headers={"x-api-key": key, "User-Agent": "curl/8.1.2"})
        for p in data.get("players", []):
            sid = qbs_by_name.get((p.get("name", "").lower(), p.get("team_id", "")))
            pts = (p.get("stats") or {}).get("points")
            if sid and pts is not None:
                out[sid] = round(float(pts), 2)
    except Exception as e:  # noqa: BLE001
        print(f"  WARNING: fantasypros projections failed: {e}", file=sys.stderr)
    return out


def build_projections(week_key, qbs):
    espn_to_sleeper = {str(q["espn_id"]): q["id"] for q in qbs if q.get("espn_id")}
    qbs_by_name = {(q["name"].lower(), q["team"]): q["id"] for q in qbs}

    print(f"Fetching projections for week {week_key}...")
    rw = sleeper_projections(week_key)
    espn = espn_projections(week_key, espn_to_sleeper)
    fp = fantasypros_projections(week_key, qbs_by_name)
    print(f"  rotowire: {len(rw)}, espn: {len(espn)}, fantasypros: {len(fp)}")

    players = {}
    for sid in set(rw) | set(espn) | set(fp):
        sources = {}
        if sid in rw and rw[sid]["pts"]:
            sources["rotowire"] = rw[sid]["pts"]
        if sid in espn:
            sources["espn"] = espn[sid]
        if sid in fp:
            sources["fantasypros"] = fp[sid]
        if not sources:
            continue
        players[sid] = {
            "sources": sources,
            "avg": round(sum(sources.values()) / len(sources), 2),
        }
    return {"season": SEASON, "week": week_key,
            "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "players": players}


# ------------------------------------------------------------------- main ---

def main():
    DATA_DIR.mkdir(exist_ok=True)

    qbs = build_qbs()
    print("Fetching schedule from ESPN...")
    schedule = build_schedule()
    week = current_week(schedule)
    print(f"Current week: {week}")
    projections = build_projections(week, qbs)

    meta = {
        "season": SEASON,
        "current_week": week,
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    for name, payload in [("qbs.json", qbs), ("schedule.json", schedule),
                          ("projections.json", projections), ("meta.json", meta)]:
        (DATA_DIR / name).write_text(json.dumps(payload, indent=1))
        print(f"Wrote data/{name}")


if __name__ == "__main__":
    main()
