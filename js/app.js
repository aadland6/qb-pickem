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
};

const WEEK_ORDER = [...Array.from({ length: 18 }, (_, i) => String(i + 1)), "P1", "P2", "P3", "P4"];
const $ = (sel) => document.querySelector(sel);

const phaseOf = (weekKey) => (weekKey.startsWith("P") ? "playoffs" : "regular");
const weekLabel = (key) => S.schedule.weeks[key]?.label || `Week ${key}`;

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
}

async function savePick(row) {
  if (S.db) {
    const { error } = await S.db.from("picks")
      .upsert(row, { onConflict: "player_name,season,phase,week_key" });
    if (error) {
      if (error.code === "23505") throw new Error(`You already used ${row.qb_name} this ${row.phase === "regular" ? "season" : "postseason"}.`);
      throw new Error(error.message);
    }
  } else {
    const all = JSON.parse(localStorage.getItem("pickem-picks") || "[]");
    const dup = all.find((p) => p.player_name === row.player_name && p.season === row.season
      && p.phase === row.phase && p.qb_id === row.qb_id && p.week_key !== row.week_key);
    if (dup) throw new Error(`You already used ${row.qb_name} in ${weekLabel(dup.week_key)}.`);
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
const gameStarted = (g) => g && kickoffDate(g) <= new Date();

function projFor(qbId, weekKey) {
  if (S.projections?.week !== weekKey) return null;
  return S.projections.players[qbId] || null;
}

function actualPts(qbId, weekKey) {
  const wk = S.scores?.weeks?.[weekKey];
  return wk && wk[qbId] ? wk[qbId].pts : null;
}

// picks helpers
const picksFor = (name) => S.picks.filter((p) => p.player_name === name);
const pickAt = (name, weekKey) => S.picks.find((p) => p.player_name === name && p.week_key === weekKey);
function usedElsewhere(name, qbId, weekKey) {
  return S.picks.find((p) => p.player_name === name && p.phase === phaseOf(weekKey)
    && p.qb_id === qbId && p.week_key !== weekKey);
}

// A pick is locked once its QB's game has kicked off.
function pickLocked(pick) {
  if (!pick) return false;
  const qb = S.qbById[pick.qb_id];
  const g = qb ? gameFor(qb.team, pick.week_key) : null;
  return gameStarted(g);
}

function pickPoints(pick) {
  const actual = actualPts(pick.qb_id, pick.week_key);
  if (actual !== null) return { pts: actual, final: true };
  return { pts: null, final: false };
}

// ------------------------------------------------------------------ UI -----

const teamLogo = (team) => `https://a.espncdn.com/i/teamlogos/nfl/500/${team === "WAS" ? "wsh" : team.toLowerCase()}.png`;
const headshot = (qb) => (qb.espn_id
  ? `https://a.espncdn.com/i/headshots/nfl/players/full/${qb.espn_id}.png`
  : "");

function fmtKick(g) {
  return kickoffDate(g).toLocaleString([], { weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3500);
}

function renderHeader() {
  $("#league-name").textContent = CONFIG.LEAGUE_NAME;
  document.title = CONFIG.LEAGUE_NAME;
  const sel = $("#me-select");
  sel.innerHTML = `<option value="">— pick your name —</option>`
    + CONFIG.PLAYERS.map((p) => `<option ${p === S.me ? "selected" : ""}>${p}</option>`).join("");

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

function renderMyPickSummary() {
  const el = $("#my-pick-summary");
  if (!S.me) { el.innerHTML = `<span class="muted">Select your name (top right) to make picks.</span>`; return; }
  const pick = pickAt(S.me, S.week);
  if (!pick) {
    el.innerHTML = `<span class="nopick">No pick yet for ${weekLabel(S.week)}.</span>`;
    return;
  }
  const qb = S.qbById[pick.qb_id];
  const locked = pickLocked(pick);
  const { pts, final } = pickPoints(pick);
  const proj = projFor(pick.qb_id, S.week);
  el.innerHTML = `
    <img class="mini-logo" src="${teamLogo(pick.qb_team)}" alt="">
    <strong>${pick.qb_name}</strong>
    <span class="muted">${pick.qb_team}</span>
    ${final ? `<span class="pts">${pts.toFixed(2)} pts</span>`
      : proj ? `<span class="muted">proj ${proj.avg.toFixed(1)}</span>` : ""}
    ${locked ? `<span class="lock">🔒 locked</span>`
      : `<button id="unpick" class="linkbtn">remove</button>`}
  `;
  if (!locked && qb) {
    $("#unpick")?.addEventListener("click", async () => {
      try { await deletePick(pick); toast("Pick removed."); render(); }
      catch (e) { toast(e.message, true); }
    });
  }
}

function qbCard(qb) {
  const g = gameFor(qb.team, S.week);
  const proj = projFor(qb.id, S.week);
  const myPick = S.me ? pickAt(S.me, S.week) : null;
  const isMyPick = myPick?.qb_id === qb.id;
  const used = S.me ? usedElsewhere(S.me, qb.id, S.week) : null;
  const started = gameStarted(g);
  const myPickLocked = pickLocked(myPick);
  const othersThisWeek = S.picks
    .filter((p) => p.week_key === S.week && p.qb_id === qb.id && p.player_name !== S.me)
    .map((p) => p.player_name);

  let status = "", cls = "";
  if (!g) { status = phaseOf(S.week) === "playoffs" ? "NOT PLAYING" : "BYE WEEK"; cls = "bye"; }
  else if (isMyPick) { status = "YOUR PICK"; cls = "mine"; }
  else if (used) { status = `USED · ${weekLabel(used.week_key).toUpperCase()}`; cls = "used"; }
  else if (started) { status = "LOCKED"; cls = "locked"; }

  const pickable = S.me && g && !started && !used && !isMyPick && !myPickLocked;
  const actual = actualPts(qb.id, S.week);

  const srcChips = proj
    ? Object.entries(proj.sources).map(([s, v]) =>
        `<span class="src" title="${s}">${{ rotowire: "RW", espn: "ESPN", fantasypros: "FP" }[s] || s} ${v.toFixed(1)}</span>`).join("")
    : `<span class="src none">no proj</span>`;

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
      ${status ? `<span class="status ${cls}">${status}</span>` : ""}
    </div>
    <div class="card-mid">
      <span class="opp">${g ? `${g.home ? "vs" : "@"} ${g.opponent}` : "—"}</span>
      <span class="kick">${g ? fmtKick(g) : ""}</span>
    </div>
    <div class="card-bottom">
      <div class="projs">
        ${actual !== null ? `<span class="pts">${actual.toFixed(2)} pts</span>` : srcChips}
        ${actual === null && proj ? `<span class="avg" title="ensemble average">avg ${proj.avg.toFixed(1)}</span>` : ""}
      </div>
      ${othersThisWeek.length ? `<div class="others" title="Also picked by">${othersThisWeek.map((n) => `<span>${n}</span>`).join("")}</div>` : ""}
      <button class="pickbtn" data-qb="${qb.id}" ${pickable ? "" : "disabled"}>
        ${isMyPick ? "✓ Picked" : "Pick"}
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

  let list = S.qbs.filter((q) => {
    if (search && !q.name.toLowerCase().includes(search)) return false;
    if (team && q.team !== team) return false;
    if (onlyStarters && q.depth > 1) return false;
    if (onlyAvail && S.me) {
      const g = gameFor(q.team, S.week);
      if (!g || gameStarted(g) || usedElsewhere(S.me, q.id, S.week)) {
        if (pickAt(S.me, S.week)?.qb_id !== q.id) return false;
      }
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

  document.querySelectorAll(".pickbtn:not([disabled])").forEach((btn) => {
    btn.addEventListener("click", () => makePick(btn.dataset.qb));
  });
}

async function makePick(qbId) {
  const qb = S.qbById[qbId];
  if (!qb || !S.me) return;
  const row = {
    player_name: S.me,
    season: CONFIG.SEASON,
    phase: phaseOf(S.week),
    week_key: S.week,
    qb_id: qb.id,
    qb_name: qb.name,
    qb_team: qb.team,
    updated_at: new Date().toISOString(),
  };
  try {
    await savePick(row);
    toast(`Locked in ${qb.name} for ${weekLabel(S.week)} ✓`);
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
    const { pts } = pickPoints(p);
    if (pts === null) continue;
    if (p.phase === "regular") reg += pts; else post += pts;
  }
  return { reg: +reg.toFixed(2), post: +post.toFixed(2), total: +(reg + post).toFixed(2) };
}

function renderLeague() {
  const rows = CONFIG.PLAYERS.map((n) => ({ name: n, ...totals(n) }))
    .sort((a, b) => b.total - a.total);

  $("#standings").innerHTML = `
    <table>
      <thead><tr><th></th><th>Player</th><th>Total</th><th>Regular</th><th>Playoffs</th></tr></thead>
      <tbody>${rows.map((r, i) => `
        <tr class="${r.name === S.me ? "me-row" : ""}">
          <td>${i === 0 && r.total > 0 ? "👑" : i + 1}</td>
          <td>${r.name}</td>
          <td><strong>${r.total.toFixed(2)}</strong></td>
          <td>${r.reg.toFixed(2)}</td>
          <td>${r.post.toFixed(2)}</td>
        </tr>`).join("")}
      </tbody>
    </table>`;

  const weeks = WEEK_ORDER.filter((k) =>
    S.picks.some((p) => p.week_key === k) || k === S.meta.current_week);
  const cell = (name, wk) => {
    const p = pickAt(name, wk);
    if (!p) return `<td class="muted">—</td>`;
    const hide = !pickLocked(p) && p.player_name !== S.me && phaseWeekStarted(wk) === false;
    const { pts, final } = pickPoints(p);
    return `<td>
      <div class="matrix-qb">${p.qb_name}</div>
      <div class="matrix-pts">${final ? pts.toFixed(2) : (hide ? "" : "…")}</div>
    </td>`;
  };
  $("#pick-matrix").innerHTML = `
    <table>
      <thead><tr><th>Player</th>${weeks.map((w) => `<th>${weekLabel(w)}</th>`).join("")}</tr></thead>
      <tbody>${CONFIG.PLAYERS.map((n) => `
        <tr class="${n === S.me ? "me-row" : ""}"><td>${n}</td>${weeks.map((w) => cell(n, w)).join("")}</tr>`).join("")}
      </tbody>
    </table>`;
}

function phaseWeekStarted(weekKey) {
  const games = S.schedule.weeks[weekKey]?.games || [];
  if (!games.length) return false;
  return new Date() >= new Date(Math.min(...games.map(kickoffDate)));
}

// ------------------------------------------------------------- top level ---

function render() {
  renderHeader();
  renderWeekNav();
  renderMyPickSummary();
  renderGrid();
  renderLeague();
  const upd = S.projections?.updated || S.meta?.updated;
  $("#data-updated").textContent = upd ? `Data updated ${new Date(upd).toLocaleString()}` : "";
}

function wire() {
  $("#me-select").addEventListener("change", (e) => {
    S.me = e.target.value || null;
    localStorage.setItem("pickem-me", S.me || "");
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
    $("#tab-picks").classList.toggle("hidden", t.dataset.tab !== "picks");
    $("#tab-league").classList.toggle("hidden", t.dataset.tab !== "league");
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

  // team filter options from actual roster
  const teams = [...new Set(S.qbs.map((q) => q.team))].sort();
  $("#team-filter").innerHTML = `<option value="">All teams</option>`
    + teams.map((t) => `<option>${t}</option>`).join("");

  wire();
  render();
}

main().catch((e) => {
  document.body.innerHTML = `<div class="fatal">Failed to load: ${e.message}</div>`;
  console.error(e);
});
