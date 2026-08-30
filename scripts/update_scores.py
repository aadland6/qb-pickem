#!/usr/bin/env python3
"""Compute actual weekly fantasy points (ESPN standard scoring) for all QBs.

Pulls raw stat lines from Sleeper's stats API and applies the ESPN standard
formula ourselves, so scoring is identical to what the site's projections use:
  0.04/pass yd, 4/pass TD, -2 INT, 0.1/rush yd, 6 rush TD, 2/two-pt, -2 fum lost

Writes data/scores.json with every week that has any completed games.
Re-running is idempotent (each week is recomputed from source).
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SEASON = int(os.environ.get("PICKEM_SEASON", "2026"))
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

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

# app week key -> (sleeper season_type, sleeper week)
# NOTE: verify playoff week numbers in January; Sleeper's postseason numbering
# has occasionally shifted (Super Bowl may land on week 4 or 5).
WEEK_MAP = {**{str(w): ("regular", w) for w in range(1, 19)},
            "P1": ("post", 1), "P2": ("post", 2), "P3": ("post", 3), "P4": ("post", 4)}


def fetch_json(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.1.2"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def std_points(stats):
    return round(sum(float(stats.get(k, 0) or 0) * w for k, w in SCORING.items()), 2)


def week_has_started(schedule, key):
    games = schedule["weeks"].get(key, {}).get("games", [])
    if not games:
        return False
    now = datetime.now(timezone.utc)
    first = min(datetime.fromisoformat(g["kickoff"].replace("Z", "+00:00")) for g in games)
    return now >= first


def fetch_week_scores(key):
    season_type, week = WEEK_MAP[key]
    url = (f"https://api.sleeper.com/stats/nfl/{SEASON}/{week}"
           f"?season_type={season_type}&position%5B%5D=QB&order_by=pts_std")
    out = {}
    for row in fetch_json(url):
        stats = row.get("stats") or {}
        if not stats.get("gp") and not stats.get("gms_active"):
            continue
        keep = {k: stats.get(k, 0) for k in
                ("pass_yd", "pass_td", "pass_int", "rush_yd", "rush_td",
                 "pass_2pt", "rush_2pt", "fum_lost")}
        out[row["player_id"]] = {"pts": std_points(stats), **{k: v for k, v in keep.items() if v}}
    return out


def main():
    schedule = json.loads((DATA_DIR / "schedule.json").read_text())
    scores_path = DATA_DIR / "scores.json"
    scores = {"season": SEASON, "weeks": {}}

    for key in WEEK_MAP:
        if not week_has_started(schedule, key):
            continue
        try:
            week_scores = fetch_week_scores(key)
        except Exception as e:  # noqa: BLE001
            print(f"WARNING: week {key} fetch failed: {e}", file=sys.stderr)
            continue
        if week_scores:
            scores["weeks"][key] = week_scores
            print(f"Week {key}: {len(week_scores)} QB stat lines")

    scores["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    scores_path.write_text(json.dumps(scores, indent=1))
    print(f"Wrote data/scores.json ({len(scores['weeks'])} weeks)")


if __name__ == "__main__":
    main()
