import { CONFIG } from "./config.js";

// ---------------------------------------------------------------- state ----

const S = {
  qbs: [],
  qbById: {},
  schedule: null,
  projections: null,
  scores: null,
  meta: null,
  picks: [],          // all rows from the picks store
  me: null,           // selected league player name
  week: null,         // current view week key ("1".."18", "P1".."P4")
  db: null,           // supabase client or null (demo mode)
  live: { week: null, stats: {}, at: null },  // in-game scoring feed
};

const SEASON_ALLOCATION = 100;
const WEEK_ORDER = [...Array.from({ length: 18 }, (_, i) => String(i + 1)), "P1", "P2", "P3", "P4"];
const $ = (sel) => document.querySelector(sel);

const phaseOf = (weekKey) => (weekKey.startsWith("P") ? "playoffs" : "regular");
const weekLabel = (key) => S.schedule.weeks[key]?.label || `Week ${key}`;

// Test hook: set window.__pickem_now to simulate a different "now".
const nowFn = () => (window.__pickem_now ? new Date(window.__pickem_now) : new Date());

// --------------------------------------------------------------- storage ---

function isConfigured() {
  return CONFIG.SUPABASE_URL.startsWith("https://") && CONFIG.SUPABASE_ANON_KEY.length > 40;
}

async function initStore() {
  if (!isConfigured()) return; // demo mode -> localStorage
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  S.db = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
}

async function loadPicks() {
  if (S.db) {
    const { data, error } = await S.db.from("picks")
      .select("*").eq("season", CONFIG.SEASON);
    if (error) { toast(`Couldn't load picks: ${error.message}`, true); return; }
    S.picks = data;
  } else {
    S.picks = JSON.parse(localStorage.getItem("pickem-picks") || "[]")
      .filter((p) => p.season === CONFIG.SEASON);
  }
  resolveWeek.cache = {};
}

async function savePick(row) {
  if (S.db) {
    const { error } = await S.db.from("picks")
      .upsert(row, { onConflict: "player_name,season,phase,week_key" });
    if (error) throw new Error(error.message);
  } else {
    const all = JSON.parse(localStorage.getItem("pickem-picks") || "[]");
    const i = all.findIndex((p) => p.player_name === row.player_name && p.season === row.season
      && p.phase === row.phase && p.week_key === row.week_key);
    if (i >= 0) all[i] = row; else all.push(row);
    localStorage.setItem("pickem-picks", JSON.stringify(all));
  }
  await loadPicks();
}

async function deletePick(pick) {
  if (S.db) {
    const { error } = await S.db.from("picks").delete()
      .eq("player_name", pick.player_name).eq("season", pick.season)
      .eq("phase", pick.phase).eq("week_key", pick.week_key);
    if (error) throw new Error(error.message);
  } else {
    const all = JSON.parse(localStorage.getItem("pickem-picks") || "[]")
      .filter((p) => !(p.player_name === pick.player_name && p.season === pick.season
        && p.phase === pick.phase && p.week_key === pick.week_key));
    localStorage.setItem("pickem-picks", JSON.stringify(all));
  }
  await loadPicks();
}

// ------------------------------------------------------------- game data ---

async function loadData() {
  const get = (f) => fetch(`data/${f}?v=${Date.now()}`).then((r) => r.json());
  [S.qbs, S.schedule, S.projections, S.scores, S.meta] = await Promise.all([
    get("qbs.json"), get("schedule.json"), get("projections.json"),
    get("scores.json").catch(() => ({ weeks: {} })), get("meta.json"),
  ]);
  S.qbById = Object.fromEntries(S.qbs.map((q) => [q.id, q]));
}

function gameFor(team, weekKey) {
  const wk = S.schedule.weeks[weekKey];
  if (!wk) return null;
  for (const g of wk.games) {
    if (g.home === team) return { ...g, opponent: g.away, home: true };
    if (g.away === team) return { ...g, opponent: g.home, home: false };
  }
  return null; // bye
}

const kickoffDate = (g) => new Date(g.kickoff.replace("Z", "+00:00"));
// A TBD placeholder time (NFL hasn't scheduled the slot yet) never counts as
// started — picks stay open and contests stay pending until the real time
// arrives via the daily data refresh.
const gameStarted = (g) => g && !g.tbd && kickoffDate(g) <= nowFn();

function projFor(qbId, weekKey) {
  if (S.projections?.week !== weekKey) return null;
  return S.projections.players[qbId] || null;
}

function actualPts(qbId, weekKey) {
  const wk = S.scores?.weeks?.[weekKey];
  if (wk && wk[qbId]) return wk[qbId].pts;
  if (S.live.week === weekKey && S.live.stats[qbId] !== undefined) return S.live.stats[qbId];
  return null;
}

// True when the number shown comes from the in-game feed, not final scores.
function ptsIsLive(qbId, weekKey) {
  const wk = S.scores?.weeks?.[weekKey];
  return !(wk && wk[qbId]) && S.live.week === weekKey && S.live.stats[qbId] !== undefined;
}

// ------------------------------------------------------- live scoring ------
// On game days, pull in-progress stat lines straight from Sleeper (CORS-open)
// and score them with the same ESPN-standard formula the pipeline uses.

const LIVE_SCORING = {
  pass_yd: 0.04, pass_td: 4, pass_int: -2, pass_2pt: 2,
  rush_yd: 0.1, rush_td: 6, rush_2pt: 2, fum_lost: -2,
};
const SLEEPER_WEEK = (key) => (key.startsWith("P")
  ? ["post", { P1: 1, P2: 2, P3: 3, P4: 4 }[key]]
  : ["regular", Number(key)]);

function anyGameLive(weekKey) {
  const now = nowFn();
  return (S.schedule.weeks[weekKey]?.games || []).some((g) => {
    if (g.tbd) return false;
    const k = kickoffDate(g);
    return k <= now && now - k < 5 * 3600 * 1000; // within ~5h of kickoff
  });
}

async function fetchLiveStats(weekKey = S.meta.current_week) {
  if (!anyGameLive(weekKey)) return false;
  const [st, wk] = SLEEPER_WEEK(weekKey);
  try {
    const rows = await fetch(
      `https://api.sleeper.com/stats/nfl/${CONFIG.SEASON}/${wk}?season_type=${st}&position%5B%5D=QB`
    ).then((r) => r.json());
    const stats = {};
    for (const r of rows) {
      const s = r.stats || {};
      if (!s.gp && !s.gms_active) continue;
      stats[r.player_id] = Math.round(
        Object.entries(LIVE_SCORING).reduce((t, [k, w]) => t + (Number(s[k]) || 0) * w, 0) * 100
      ) / 100;
    }
    S.live = { week: weekKey, stats, at: Date.now() };
    return true;
  } catch { return false; }
}

function startLivePolling() {
  const tick = async () => {
    if (!document.hidden && await fetchLiveStats()) render();
  };
  tick();
  setInterval(tick, 60_000);
}

const picksFor = (name) => S.picks.filter((p) => p.player_name === name);
const pickAt = (name, weekKey) => S.picks.find((p) => p.player_name === name && p.week_key === weekKey);

// ------------------------------------------------------ realtime alerts ----
// Supabase broadcasts picks changes to every open tab: standings and cards
// refresh instantly, and you get a notification when someone contests a QB
// you're holding.

function myRivalsMap() {
  const map = {};
  if (!S.me) return map;
  for (const p of picksFor(S.me)) {
    const e = resolveWeek(p.week_key)[S.me];
    if (e && !e.pending) continue; // settled weeks can't gain rivals
    map[p.week_key] = claimsOn(p.qb_id, p.week_key).filter((n) => n !== S.me);
  }
  return map;
}

function notify(title, body) {
  toast(`${title} ${body}`);
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification(title, { body, icon: "icons/icon-192.png" }); } catch { /* ignore */ }
  }
}

function initRealtime() {
  if (!S.db) return;
  S.db.channel("picks-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "picks" }, async () => {
      const before = myRivalsMap();
      await loadPicks();
      const after = myRivalsMap();
      for (const [wk, rivals] of Object.entries(after)) {
        const fresh = rivals.filter((n) => !(before[wk] || []).includes(n));
        if (fresh.length) {
          const pick = pickAt(S.me, wk);
          notify("⚔️ Contest!", `${fresh.join(", ")} is contesting ${pick.qb_name} (${weekLabel(wk)}) — check your bid.`);
        }
      }
      render();
    })
    .subscribe();
}

// ------------------------------------------------------- auction engine ----
//
// Rules:
//  * Several players may claim (pick) the same QB in a week: he is CONTESTED.
//  * At the QB's kickoff the contest resolves: highest bid wins; equal bids
//    go to the player with the LOWEST season total entering that week, and
//    if that also ties, to the earliest claim. Only a contested winner spends
//    their bid, from a single 100-point allocation covering the whole season
//    incl. playoffs.
//  * Losers fall back to their backup QB automatically, in claim order,
//    if: nobody claimed the backup as a primary this week, no earlier loser
//    grabbed him first, and his game hadn't kicked off before the primary's.
//  * Losing an auction does NOT use up the QB for that player.
//
// Everything is derived deterministically from the picks table, so every
// browser computes the same outcome — no server needed.

function resolveWeek(weekKey) {
  if (resolveWeek.cache[weekKey]) return resolveWeek.cache[weekKey];

  const rows = S.picks.filter((p) => p.week_key === weekKey);
  const byQb = {};
  rows.forEach((p) => (byQb[p.qb_id] ||= []).push(p));

  const byPlayer = {};
  const losers = [];

  for (const claims of Object.values(byQb)) {
    const qb = S.qbById[claims[0].qb_id];
    const g = qb ? gameFor(qb.team, weekKey) : null;
    const contested = claims.length > 1;
    if (!g || !gameStarted(g)) {
      claims.forEach((c) => {
        byPlayer[c.player_name] = {
          pending: true, contested, primaryQbId: c.qb_id,
          rivals: claims.filter((x) => x !== c).map((x) => x.player_name),
        };
      });
      continue;
    }
    const sorted = [...claims].sort((a, b) =>
      (b.bid - a.bid)
      || (totalPointsBefore(a.player_name, weekKey) - totalPointsBefore(b.player_name, weekKey))
      || (new Date(a.claimed_at) - new Date(b.claimed_at)));
    const w = sorted[0];
    byPlayer[w.player_name] = {
      qbId: w.qb_id, source: "primary", spent: contested ? w.bid : 0,
      primaryQbId: w.qb_id, contested,
      rivals: sorted.slice(1).map((x) => x.player_name),
    };
    sorted.slice(1).forEach((l) => losers.push({ pick: l, primaryGame: g, winner: w.player_name }));
  }

  // Backups activate in claim order; any primary claim on a QB blocks him.
  const primaryClaimed = new Set(rows.map((p) => p.qb_id));
  const backupTaken = new Set();
  losers.sort((a, b) => new Date(a.pick.claimed_at) - new Date(b.pick.claimed_at));
  for (const { pick, primaryGame, winner } of losers) {
    const entry = {
      qbId: null, source: "none", spent: 0, lost: true, contested: true,
      primaryQbId: pick.qb_id, lostTo: winner, rivals: [winner],
    };
    const bId = pick.backup_qb_id;
    if (bId && !primaryClaimed.has(bId) && !backupTaken.has(bId)) {
      const bqb = S.qbById[bId];
      const bg = bqb ? gameFor(bqb.team, weekKey) : null;
      if (bg && kickoffDate(bg) >= kickoffDate(primaryGame)) {
        entry.qbId = bId;
        entry.source = "backup";
        backupTaken.add(bId);
      }
    }
    byPlayer[pick.player_name] = entry;
  }

  return (resolveWeek.cache[weekKey] = byPlayer);
}
resolveWeek.cache = {};

// Season total (regular + playoffs) from weeks strictly before `weekKey` —
// the auction tie-break: the trailing player wins an equal-bid contest.
function totalPointsBefore(name, weekKey) {
  const cutoff = WEEK_ORDER.indexOf(weekKey);
  let total = 0;
  for (const p of picksFor(name)) {
    if (WEEK_ORDER.indexOf(p.week_key) >= cutoff) continue;
    total += effectivePoints(name, p.week_key) ?? 0;
  }
  return total;
}

// A player's week is settled (unchangeable) once they hold an effective QB.
function weekSettled(name, weekKey) {
  const e = resolveWeek(weekKey)[name];
  return !!(e && !e.pending);
}

// QBs a player can no longer pick in `weekKey` (same phase).
function blockedSet(name, weekKey) {
  const set = new Set();
  for (const p of picksFor(name)) {
    if (p.phase !== phaseOf(weekKey) || p.week_key === weekKey) continue;
    const e = resolveWeek(p.week_key)[name];
    if (e && !e.pending) {
      if (e.qbId) set.add(e.qbId);            // effective QB is used up
    } else {
      set.add(p.qb_id);                        // reserved primary
      if (p.backup_qb_id) set.add(p.backup_qb_id); // reserved backup
    }
  }
  return set;
}

// Resolved holder of a QB this week (winner or activated backup), if any.
function holderOf(qbId, weekKey) {
  for (const [name, e] of Object.entries(resolveWeek(weekKey))) {
    if (!e.pending && e.qbId === qbId) return name;
  }
  return null;
}

// Unresolved primary claims on a QB this week.
function claimsOn(qbId, weekKey) {
  return S.picks.filter((p) => p.week_key === weekKey && p.qb_id === qbId)
    .map((p) => p.player_name);
}

// Allocation: spent (contested wins) + committed (pending bids) across season.
function allocation(name) {
  let spent = 0, committed = 0;
  for (const p of picksFor(name)) {
    const e = resolveWeek(p.week_key)[name];
    if (e && !e.pending) {
      if (e.source === "primary") spent += e.spent;
    } else {
      committed += p.bid || 0;
    }
  }
  return { spent, committed, remaining: SEASON_ALLOCATION - spent - committed };
}

function effectivePoints(name, weekKey) {
  const e = resolveWeek(weekKey)[name];
  if (!e || e.pending || !e.qbId) return null;
  return actualPts(e.qbId, weekKey);
}

// ------------------------------------------------------------------ UI -----

const teamLogo = (team) => `https://a.espncdn.com/i/teamlogos/nfl/500/${team === "WAS" ? "wsh" : team.toLowerCase()}.png`;
const headshot = (qb) => (qb.espn_id
  ? `https://a.espncdn.com/i/headshots/nfl/players/full/${qb.espn_id}.png`
  : "");

function fmtKick(g) {
  if (g.tbd) return `${kickoffDate(g).toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" })} · time TBD`;
  return kickoffDate(g).toLocaleString([], { weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 4000);
}

function renderHeader() {
  $("#league-name").textContent = CONFIG.LEAGUE_NAME;
  document.title = CONFIG.LEAGUE_NAME;
  const sel = $("#me-select");
  sel.innerHTML = `<option value="">— pick your name —</option>`
    + CONFIG.PLAYERS.map((p) => `<option ${p === S.me ? "selected" : ""}>${p}</option>`).join("");
  $("#alloc-chip").textContent = S.me ? `⚡ ${allocation(S.me).remaining} pts left` : "";

  if (!S.db) {
    const b = $("#banner");
    b.textContent = "Demo mode — Supabase isn't configured yet, so picks save only in this browser. See README for the 10-minute setup.";
    b.classList.remove("hidden");
  }
}

function renderWeekNav() {
  const sel = $("#week-select");
  sel.innerHTML = WEEK_ORDER
    .filter((k) => S.schedule.weeks[k]?.games.length)
    .map((k) => `<option value="${k}" ${k === S.week ? "selected" : ""}>${weekLabel(k)}${phaseOf(k) === "playoffs" ? " (playoffs)" : ""}</option>`)
    .join("");
  const games = S.schedule.weeks[S.week].games;
  if (games.length) {
    const dates = games.map(kickoffDate);
    const fmt = (d) => d.toLocaleDateString([], { month: "short", day: "numeric" });
    $("#week-dates").textContent = `${fmt(new Date(Math.min(...dates)))} – ${fmt(new Date(Math.max(...dates)))}`;
  } else {
    $("#week-dates").textContent = "";
  }
}

// Backup choices: playing this week, not blocked, not primary-claimed by anyone.
function backupOptions(pick) {
  return S.qbs.filter((q) => {
    if (q.id === pick.qb_id) return false;
    if (q.depth > 1 && !projFor(q.id, S.week)) return false; // starters/projected only
    const g = gameFor(q.team, S.week);
    if (!g || gameStarted(g)) return false;
    if (blockedSet(S.me, S.week).has(q.id)) return false;
    if (claimsOn(q.id, S.week).length) return false;
    return true;
  }).sort((a, b) => (projFor(b.id, S.week)?.avg ?? -1) - (projFor(a.id, S.week)?.avg ?? -1));
}

function renderMyPickSummary() {
  const el = $("#my-pick-summary");
  if (!S.me) { el.innerHTML = `<span class="muted">Select your name (top right) to make picks.</span>`; return; }
  const pick = pickAt(S.me, S.week);
  if (!pick) {
    el.innerHTML = `<span class="nopick">No pick yet for ${weekLabel(S.week)}.</span>`;
    return;
  }
  const e = resolveWeek(S.week)[S.me];

  // ----- settled week -----
  if (e && !e.pending) {
    let line;
    if (e.source === "primary") {
      line = `<strong>${pick.qb_name}</strong><span class="muted">${pick.qb_team}</span>`
        + (e.contested ? `<span class="won">won the auction (bid ${e.spent})</span>` : `<span class="lock">🔒 locked</span>`);
    } else if (e.source === "backup") {
      line = `<span class="lostline">Lost <strong>${pick.qb_name}</strong> to ${e.lostTo}</span>`
        + `<span class="won">→ backup <strong>${pick.backup_qb_name}</strong> is in</span>`;
    } else {
      line = `<span class="lostline">Lost <strong>${pick.qb_name}</strong> to ${e.lostTo} — no valid backup.</span>`
        + `<span class="nopick">Pick any QB with a later kickoff!</span>`;
    }
    const pts = effectivePoints(S.me, S.week);
    const live = pts !== null && e.qbId && ptsIsLive(e.qbId, S.week) ? ` <span class="live-dot">LIVE</span>` : "";
    el.innerHTML = `<img class="mini-logo" src="${teamLogo((S.qbById[e.qbId] || pick).qb_team || S.qbById[e.qbId]?.team || pick.qb_team)}" alt="">
      ${line} ${pts !== null ? `<span class="pts">${pts.toFixed(2)} pts${live}</span>` : ""}`;
    return;
  }

  // ----- pending week: bid + backup controls -----
  const rivals = e?.rivals || [];
  const alloc = allocation(S.me);
  const maxBid = alloc.remaining + (pick.bid || 0);
  const options = backupOptions(pick);
  const proj = projFor(pick.qb_id, S.week);

  el.innerHTML = `
    <div class="pick-line">
      <img class="mini-logo" src="${teamLogo(pick.qb_team)}" alt="">
      <strong>${pick.qb_name}</strong>
      <span class="muted">${pick.qb_team}</span>
      ${proj ? `<span class="muted">proj ${proj.avg.toFixed(1)}</span>` : ""}
      ${rivals.length
        ? `<span class="contested-tag">⚔️ Contested with ${rivals.join(", ")}</span>`
        : `<span class="safe-tag">uncontested</span>`}
      <button id="unpick" class="linkbtn">remove</button>
    </div>
    <div class="bid-panel">
      <label>Bid <input id="bid-input" type="number" min="0" max="${maxBid}" step="1" value="${pick.bid || 0}">
        <span class="muted">/ ${maxBid} available</span></label>
      <label>Backup
        <select id="backup-select">
          <option value="">— none —</option>
          ${options.map((q) => {
            const p = projFor(q.id, S.week);
            return `<option value="${q.id}" ${q.id === pick.backup_qb_id ? "selected" : ""}>${q.name} (${q.team}${p ? `, ${p.avg.toFixed(1)}` : ""})</option>`;
          }).join("")}
        </select></label>
      <button id="save-bid" class="pickbtn">Save</button>
      <span class="muted hint">Highest bid wins at kickoff. Ties go to the player with fewer season points (then first claim). Only the winner spends points. Losers get their backup.</span>
    </div>`;

  $("#unpick").addEventListener("click", async () => {
    try { await deletePick(pick); toast("Pick removed."); render(); }
    catch (err) { toast(err.message, true); }
  });
  $("#save-bid").addEventListener("click", async () => {
    const bid = Math.floor(Number($("#bid-input").value) || 0);
    if (bid < 0 || bid > maxBid) { toast(`Bid must be between 0 and ${maxBid}.`, true); return; }
    const bidQb = S.qbById[$("#backup-select").value] || null;
    try {
      await savePick({
        ...pick, bid,
        backup_qb_id: bidQb?.id ?? null,
        backup_qb_name: bidQb?.name ?? null,
        backup_qb_team: bidQb?.team ?? null,
        updated_at: new Date().toISOString(),
      });
      toast("Bid & backup saved ✓");
      render();
    } catch (err) { toast(err.message, true); }
  });
}

function qbCard(qb) {
  const g = gameFor(qb.team, S.week);
  const proj = projFor(qb.id, S.week);
  const started = gameStarted(g);
  const res = resolveWeek(S.week);
  const myEntry = S.me ? res[S.me] : null;
  const myPick = S.me ? pickAt(S.me, S.week) : null;
  const isMyPrimary = myPick?.qb_id === qb.id;
  const isMyBackupActive = myEntry && !myEntry.pending && myEntry.source === "backup" && myEntry.qbId === qb.id;
  const holder = holderOf(qb.id, S.week);
  const claims = claimsOn(qb.id, S.week);
  const otherClaims = claims.filter((n) => n !== S.me);
  const blocked = S.me ? blockedSet(S.me, S.week).has(qb.id) : false;
  const mySettledWithQb = myEntry && !myEntry.pending && !!myEntry.qbId;

  let status = "", cls = "";
  if (!g) { status = phaseOf(S.week) === "playoffs" ? "NOT PLAYING" : "BYE WEEK"; cls = "bye"; }
  else if (isMyBackupActive) { status = "YOUR PICK · BACKUP"; cls = "mine"; }
  else if (isMyPrimary && claims.length > 1) { status = "CONTESTED"; cls = "contested mine"; }
  else if (isMyPrimary) { status = "YOUR PICK"; cls = "mine"; }
  else if (holder && holder !== S.me) { status = `TAKEN · ${holder.toUpperCase()}`; cls = "used"; }
  else if (otherClaims.length > 1) { status = `CONTESTED · ${otherClaims.join(" vs ").toUpperCase()}`; cls = "contested"; }
  else if (otherClaims.length === 1) { status = `CLAIMED · ${otherClaims[0].toUpperCase()}`; cls = "claimed"; }
  else if (blocked) { status = "USED / RESERVED"; cls = "used"; }
  else if (started) { status = "LOCKED"; cls = "locked"; }

  const pickable = S.me && g && !started && !blocked && !isMyPrimary
    && !(holder && holder !== S.me) && !mySettledWithQb;
  const actual = actualPts(qb.id, S.week);

  const srcChips = proj
    ? Object.entries(proj.sources).map(([s, v]) =>
        `<span class="src" title="${s}">${{ rotowire: "RW", espn: "ESPN", fantasypros: "FP" }[s] || s} ${v.toFixed(1)}</span>`).join("")
    : `<span class="src none">no proj</span>`;

  const btnLabel = isMyPrimary || isMyBackupActive ? "✓ Picked"
    : otherClaims.length && !holder ? "Contest"
    : "Pick";

  return `
  <div class="card ${cls}">
    <div class="card-top">
      <div class="headshot-wrap">
        ${headshot(qb) ? `<img class="headshot" loading="lazy" src="${headshot(qb)}" onerror="this.remove()" alt="">` : ""}
      </div>
      <div class="card-id">
        <div class="qb-name">${qb.name}</div>
        <div class="qb-sub">
          <img class="mini-logo" src="${teamLogo(qb.team)}" alt="">
          <span>${qb.team}${qb.number ? ` · #${qb.number}` : ""}</span>
          ${qb.injury ? `<span class="injury">${qb.injury}</span>` : ""}
        </div>
      </div>
      ${status ? `<span class="status ${cls.split(" ")[0]}">${status}</span>` : ""}
    </div>
    <div class="card-mid">
      <span class="opp">${g ? `${g.home ? "vs" : "@"} ${g.opponent}` : "—"}</span>
      <span class="kick">${g ? fmtKick(g) : ""}</span>
    </div>
    <div class="card-bottom">
      <div class="projs">
        ${actual !== null ? `<span class="pts">${actual.toFixed(2)} pts${ptsIsLive(qb.id, S.week) ? ` <span class="live-dot">LIVE</span>` : ""}</span>` : srcChips}
        ${actual === null && proj ? `<span class="avg" title="ensemble average">avg ${proj.avg.toFixed(1)}</span>` : ""}
      </div>
      <button class="pickbtn ${btnLabel === "Contest" ? "contestbtn" : ""}" data-qb="${qb.id}" ${pickable ? "" : "disabled"}>
        ${btnLabel}
      </button>
    </div>
  </div>`;
}

function renderGrid() {
  const search = $("#search").value.trim().toLowerCase();
  const team = $("#team-filter").value;
  const sortBy = $("#sort-by").value;
  const onlyAvail = $("#only-available").checked;
  const onlyStarters = $("#only-starters").checked;

  const list = S.qbs.filter((q) => {
    if (search && !q.name.toLowerCase().includes(search)) return false;
    if (team && q.team !== team) return false;
    if (onlyStarters && q.depth > 1) return false;
    if (onlyAvail && S.me) {
      const g = gameFor(q.team, S.week);
      const holder = holderOf(q.id, S.week);
      const mine = pickAt(S.me, S.week)?.qb_id === q.id
        || (resolveWeek(S.week)[S.me]?.qbId === q.id);
      if (!mine && (!g || gameStarted(g) || blockedSet(S.me, S.week).has(q.id)
        || (holder && holder !== S.me))) return false;
    }
    return true;
  });

  const proj = (q) => projFor(q.id, S.week)?.avg ?? -1;
  if (sortBy === "proj") list.sort((a, b) => proj(b) - proj(a) || a.name.localeCompare(b.name));
  if (sortBy === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  if (sortBy === "team") list.sort((a, b) => a.team.localeCompare(b.team) || a.depth - b.depth);

  $("#qb-grid").innerHTML = list.length
    ? list.map(qbCard).join("")
    : `<p class="muted empty">No quarterbacks match these filters.</p>`;

  document.querySelectorAll(".pickbtn[data-qb]:not([disabled])").forEach((btn) => {
    btn.addEventListener("click", () => makePick(btn.dataset.qb));
  });
}

async function makePick(qbId) {
  const qb = S.qbById[qbId];
  if (!qb || !S.me) return;
  const existing = pickAt(S.me, S.week);
  const sameQb = existing?.qb_id === qb.id;
  const row = {
    player_name: S.me,
    season: CONFIG.SEASON,
    phase: phaseOf(S.week),
    week_key: S.week,
    qb_id: qb.id,
    qb_name: qb.name,
    qb_team: qb.team,
    // changing QB starts a fresh claim: new tie-break time, bid/backup reset
    bid: sameQb ? existing.bid : 0,
    backup_qb_id: sameQb ? existing.backup_qb_id : null,
    backup_qb_name: sameQb ? existing.backup_qb_name : null,
    backup_qb_team: sameQb ? existing.backup_qb_team : null,
    claimed_at: sameQb ? existing.claimed_at : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  try {
    await savePick(row);
    const rivals = claimsOn(qb.id, S.week).filter((n) => n !== S.me);
    toast(rivals.length
      ? `⚔️ Contesting ${qb.name} with ${rivals.join(", ")} — set your bid below!`
      : `Locked in ${qb.name} for ${weekLabel(S.week)} ✓`);
    render();
  } catch (e) {
    toast(e.message, true);
    await loadPicks();
    render();
  }
}

// ----------------------------------------------------------- league tab ----

function totals(name) {
  let reg = 0, post = 0;
  for (const p of picksFor(name)) {
    const pts = effectivePoints(name, p.week_key);
    if (pts === null) continue;
    if (p.phase === "regular") reg += pts; else post += pts;
  }
  return { reg: +reg.toFixed(2), post: +post.toFixed(2), total: +(reg + post).toFixed(2) };
}

function renderLeague() {
  const rows = CONFIG.PLAYERS.map((n) => ({ name: n, ...totals(n), alloc: allocation(n) }))
    .sort((a, b) => b.total - a.total);

  $("#standings").innerHTML = `
    <table>
      <thead><tr><th></th><th>Player</th><th>Total</th><th>Regular</th><th>Playoffs</th><th>Allocation left</th></tr></thead>
      <tbody>${rows.map((r, i) => `
        <tr class="${r.name === S.me ? "me-row" : ""}">
          <td>${i === 0 && r.total > 0 ? "👑" : i + 1}</td>
          <td>${r.name}</td>
          <td><strong>${r.total.toFixed(2)}</strong></td>
          <td>${r.reg.toFixed(2)}</td>
          <td>${r.post.toFixed(2)}</td>
          <td>⚡ ${SEASON_ALLOCATION - r.alloc.spent}${r.alloc.committed ? ` <span class="muted">(${r.alloc.committed} bid)</span>` : ""}</td>
        </tr>`).join("")}
      </tbody>
    </table>`;

  const weeks = WEEK_ORDER.filter((k) =>
    S.picks.some((p) => p.week_key === k) || k === S.meta.current_week);
  const cell = (name, wk) => {
    const p = pickAt(name, wk);
    if (!p) return `<td class="muted">—</td>`;
    const e = resolveWeek(wk)[name];
    if (e && !e.pending) {
      const pts = effectivePoints(name, wk);
      const liveTag = pts !== null && ptsIsLive(e.qbId, wk) ? ` <span class="live-dot">LIVE</span>` : "";
      if (e.source === "primary") {
        return `<td><div class="matrix-qb">${p.qb_name}${e.contested ? ` <span class="bid-badge">won ${e.spent}</span>` : ""}</div>
          <div class="matrix-pts">${pts !== null ? pts.toFixed(2) + liveTag : "…"}</div></td>`;
      }
      if (e.source === "backup") {
        return `<td><div class="matrix-qb">↩ ${p.backup_qb_name} <span class="bid-badge backup">backup</span></div>
          <div class="matrix-pts">${pts !== null ? pts.toFixed(2) + liveTag : "…"}</div></td>`;
      }
      return `<td><div class="matrix-qb lostline">lost ${p.qb_name}</div><div class="matrix-pts">0</div></td>`;
    }
    // pending: show the claim; bids stay hidden until kickoff
    const contested = (e?.rivals || []).length > 0;
    return `<td><div class="matrix-qb">${p.qb_name}${contested ? ` <span class="bid-badge contested">⚔️</span>` : ""}</div>
      <div class="matrix-pts muted">${contested ? "contested" : "pending"}</div></td>`;
  };
  $("#pick-matrix").innerHTML = `
    <table>
      <thead><tr><th>Player</th>${weeks.map((w) => `<th>${weekLabel(w)}</th>`).join("")}</tr></thead>
      <tbody>${CONFIG.PLAYERS.map((n) => `
        <tr class="${n === S.me ? "me-row" : ""}"><td>${n}</td>${weeks.map((w) => cell(n, w)).join("")}</tr>`).join("")}
      </tbody>
    </table>`;
}

// ---------------------------------------------------------- insights tab ---

function finalWeeks() {
  return WEEK_ORDER.filter((k) => S.scores?.weeks?.[k]);
}

function renderInsights() {
  const el = $("#insights");
  const weeks = finalWeeks();

  // Auction log works even before any games finish.
  const auctionRows = [];
  for (const wk of WEEK_ORDER) {
    const res = resolveWeek(wk);
    const seen = new Set();
    for (const [name, e] of Object.entries(res)) {
      if (e.pending || !e.contested || e.source !== "primary" || seen.has(e.primaryQbId)) continue;
      seen.add(e.primaryQbId);
      const losers = Object.entries(res)
        .filter(([, x]) => !x.pending && x.lost && x.primaryQbId === e.primaryQbId)
        .map(([n, x]) => `${n} (${pickAt(n, wk)?.bid ?? 0}${x.source === "backup" ? ` → ${pickAt(n, wk)?.backup_qb_name}` : ", no backup"})`);
      auctionRows.push(`<tr><td>${weekLabel(wk)}</td><td>${S.qbById[e.primaryQbId]?.name || "?"}</td>
        <td><strong>${name}</strong> · bid ${e.spent}</td><td>${losers.join("; ") || "—"}</td></tr>`);
    }
  }

  let weekly = "", bestworst = "", board = "";
  if (weeks.length) {
    weekly = weeks.map((wk) => {
      const scores = CONFIG.PLAYERS.map((n) => ({ n, pts: effectivePoints(n, wk) ?? 0 }))
        .sort((a, b) => b.pts - a.pts);
      const top = scores[0];
      return `<tr><td>${weekLabel(wk)}</td><td>👑 ${top.n}</td><td>${top.pts.toFixed(2)}</td>
        <td class="muted">${scores.slice(1).map((s) => `${s.n} ${s.pts.toFixed(2)}`).join(" · ")}</td></tr>`;
    }).join("");

    bestworst = CONFIG.PLAYERS.map((n) => {
      const rows = weeks
        .map((wk) => ({ wk, pts: effectivePoints(n, wk), e: resolveWeek(wk)[n] }))
        .filter((r) => r.pts !== null);
      if (!rows.length) return "";
      const best = rows.reduce((a, b) => (b.pts > a.pts ? b : a));
      const worst = rows.reduce((a, b) => (b.pts < a.pts ? b : a));
      const qb = (r) => S.qbById[r.e.qbId]?.name || "—";
      return `<tr><td>${n}</td><td class="matrix-pts">${qb(best)} · ${best.pts.toFixed(2)} (${weekLabel(best.wk)})</td>
        <td class="lostline">${qb(worst)} · ${worst.pts.toFixed(2)} (${weekLabel(worst.wk)})</td></tr>`;
    }).join("");

    board = weeks.map((wk) => {
      const takenIds = new Set(Object.values(resolveWeek(wk)).filter((e) => !e.pending && e.qbId).map((e) => e.qbId));
      const all = Object.entries(S.scores.weeks[wk] || {})
        .filter(([id]) => !takenIds.has(id) && S.qbById[id])
        .sort((a, b) => b[1].pts - a[1].pts);
      if (!all.length) return "";
      const [id, row] = all[0];
      return `<tr><td>${weekLabel(wk)}</td><td>${S.qbById[id].name} (${S.qbById[id].team})</td><td>${row.pts.toFixed(2)}</td></tr>`;
    }).join("");
  }

  el.innerHTML = `
    <h2>Auction log</h2>
    ${auctionRows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Week</th><th>QB</th><th>Winner</th><th>Lost out</th></tr></thead><tbody>${auctionRows.join("")}</tbody></table></div>`
      : `<p class="muted">No auctions have resolved yet. Contested picks appear here with bids revealed after kickoff.</p>`}
    <h2>Weekly crowns</h2>
    ${weekly
      ? `<div class="table-wrap"><table><thead><tr><th>Week</th><th>High scorer</th><th>Points</th><th>The field</th></tr></thead><tbody>${weekly}</tbody></table></div>`
      : `<p class="muted">Crowns are handed out once games finish.</p>`}
    ${bestworst ? `<h2>Best & worst calls</h2>
      <div class="table-wrap"><table><thead><tr><th>Player</th><th>Best pick</th><th>Worst pick</th></tr></thead><tbody>${bestworst}</tbody></table></div>` : ""}
    ${board ? `<h2>Points left on the board</h2>
      <p class="muted">The best QB nobody rostered each week.</p>
      <div class="table-wrap"><table><thead><tr><th>Week</th><th>Best available</th><th>Points</th></tr></thead><tbody>${board}</tbody></table></div>` : ""}`;
}

// ----------------------------------------------------------- planner tab ---

function renderPlanner() {
  const el = $("#planner");
  if (!S.me) {
    el.innerHTML = `<p class="muted">Select your name (top right) to plan your remaining QBs.</p>`;
    return;
  }
  const cur = S.meta.current_week;
  const phase = phaseOf(cur);
  const weeks = WEEK_ORDER.filter((k) => phaseOf(k) === phase
    && WEEK_ORDER.indexOf(k) >= WEEK_ORDER.indexOf(cur)
    && S.schedule.weeks[k]?.games.length);
  // '0' is a synthetic same-phase key so no week's reservations are excluded.
  const blocked = blockedSet(S.me, phase === "regular" ? "0" : "P0");
  const myWeeks = Object.fromEntries(picksFor(S.me)
    .filter((p) => p.phase === phase).map((p) => [p.week_key, p.qb_id]));

  const rows = S.qbs
    .filter((q) => (q.depth === 1 || projFor(q.id, cur)) && !blocked.has(q.id))
    .sort((a, b) => (projFor(b.id, cur)?.avg ?? -1) - (projFor(a.id, cur)?.avg ?? -1));

  el.innerHTML = `
    <h2>Remaining QBs — ${phase === "regular" ? "regular season" : "playoffs"}</h2>
    <p class="muted">QBs still in your pool, and who they play each week. Your claims are highlighted; plan around byes (—).</p>
    <div class="table-wrap planner-wrap"><table>
      <thead><tr><th>QB</th>${weeks.map((w) => `<th>${phase === "regular" ? "W" + w : weekLabel(w)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((q) => `
        <tr><td class="planner-qb"><img class="mini-logo" src="${teamLogo(q.team)}" alt=""> ${q.name}</td>
          ${weeks.map((w) => {
            const g = gameFor(q.team, w);
            const mine = myWeeks[w] === q.id;
            if (!g) return `<td class="planner-bye">—</td>`;
            return `<td class="${mine ? "planner-mine" : ""}">${g.home ? "" : "@"}${g.opponent}${g.tbd ? "*" : ""}</td>`;
          }).join("")}
        </tr>`).join("")}
      </tbody>
    </table></div>
    <p class="muted">* kickoff time not yet set by the NFL</p>`;
}

// ------------------------------------------------------------- top level ---

function render() {
  resolveWeek.cache = {};
  renderHeader();
  renderWeekNav();
  renderMyPickSummary();
  renderGrid();
  renderLeague();
  renderInsights();
  renderPlanner();
  const upd = S.projections?.updated || S.meta?.updated;
  $("#data-updated").textContent = upd ? `Data updated ${new Date(upd).toLocaleString()}` : "";
}

function wire() {
  $("#me-select").addEventListener("change", (e) => {
    S.me = e.target.value || null;
    localStorage.setItem("pickem-me", S.me || "");
    // user gesture — the right moment to ask for contest notifications
    if (S.me && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
    render();
  });
  $("#week-select").addEventListener("change", (e) => { S.week = e.target.value; render(); });
  $("#week-prev").addEventListener("click", () => stepWeek(-1));
  $("#week-next").addEventListener("click", () => stepWeek(1));
  ["#search", "#team-filter", "#sort-by", "#only-available", "#only-starters"].forEach((sel) => {
    $(sel).addEventListener("input", renderGrid);
  });
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    document.querySelectorAll(".tab-panel").forEach((p) =>
      p.classList.toggle("hidden", p.id !== `tab-${t.dataset.tab}`));
  }));
  document.addEventListener("visibilitychange", async () => {
    if (!document.hidden) { await loadPicks(); render(); }
  });
}

function stepWeek(dir) {
  const avail = WEEK_ORDER.filter((k) => S.schedule.weeks[k]?.games.length);
  const i = avail.indexOf(S.week) + dir;
  if (i >= 0 && i < avail.length) { S.week = avail[i]; render(); }
}

async function main() {
  await Promise.all([loadData(), initStore()]);
  await loadPicks();

  S.me = localStorage.getItem("pickem-me") || null;
  if (S.me && !CONFIG.PLAYERS.includes(S.me)) S.me = null;
  S.week = S.meta.current_week;

  const teams = [...new Set(S.qbs.map((q) => q.team))].sort();
  $("#team-filter").innerHTML = `<option value="">All teams</option>`
    + teams.map((t) => `<option>${t}</option>`).join("");

  wire();
  render();
  initRealtime();
  startLivePolling();
}

// Debug/test handles (also used by automated checks).
window.__pickem = { S, resolveWeek, allocation, blockedSet, totalPointsBefore, gameFor, fetchLiveStats, anyGameLive };

main().catch((e) => {
  document.body.innerHTML = `<div class="fatal">Failed to load: ${e.message}</div>`;
  console.error(e);
});
