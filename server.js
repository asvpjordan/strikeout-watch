/**
 * Strikeout Watch — backend
 *
 * Endpoints:
 *   GET /api/dashboard?date=YYYY-MM-DD  → schedule + probable pitchers, top/bottom 10 K teams, top 50 pitcher K leaders
 *   GET /api/bvp?date=YYYY-MM-DD        → batter-vs-pitcher edges (10+ AB, .500+ AVG or 50%+ K rate)
 *   GET /api/props?date=YYYY-MM-DD      → Kalshi strikeout prop lines (2+ to 12+) with season hit rate per pitcher/line
 *   GET /api/live?date=YYYY-MM-DD       → live in-game K counts + pace for today's probable pitchers
 *   GET /api/workload?date=YYYY-MM-DD   → each starter's own avg IP/pitches per start vs. how long
 *                                          opposing starters typically last against that lineup
 *   GET /api/parlay-picks               → AI-picked strongest strikeout-prop legs for today,
 *                                          computed once a day. { unavailable: true } until
 *                                          ANTHROPIC_API_KEY is set — no code change needed to turn on.
 *
 * All responses share the shape { updatedAt, data }, where updatedAt is
 * the epoch-ms timestamp of the underlying computation (not the request).
 *
 * For today's date, every route is a pure read from an in-memory `store` that
 * background jobs keep fresh on their own schedule (see "background refresh"
 * below) — no live upstream fetch happens on the request path, so page loads
 * are instant and immune to Render's request-time limits. For any other date
 * (a visitor browsing a past or future day via the date picker), data is
 * fetched on demand and cached per-date for TTL_MS, same as before.
 *
 * MLB data is fetched server-side from statsapi.mlb.com (free, no key);
 * prop lines come from Kalshi's public market data API (also free, no key);
 * AI parlay picks use the Anthropic Messages API (requires ANTHROPIC_API_KEY).
 * No CORS issues since everything happens server-side.
 */

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const MLB = "https://statsapi.mlb.com/api/v1";
const MLB_LIVE = "https://statsapi.mlb.com/api/v1.1";
const KALSHI = "https://external-api.kalshi.com/trade-api/v2";
const KALSHI_SERIES = "KXMLBKS";
const PROP_LINES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const LIVE_STATUSES = new Set(["Scheduled", "Pre-Game"]); // statuses that DON'T need a live-feed fetch yet

// ---------- per-date cache (only used for on-demand, non-today lookups) ----------
const cache = new Map(); // key -> { updatedAt, data }
const TTL_MS = 30 * 60 * 1000; // 30 minutes

function cacheGet(key, ttl = TTL_MS) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.updatedAt < ttl) return hit;
  return null;
}
function cacheSet(key, envelope) {
  cache.set(key, envelope);
}
async function getOrCompute(key, ttl, fn) {
  const cached = cacheGet(key, ttl);
  if (cached) return cached;
  const envelope = { updatedAt: Date.now(), data: await fn() };
  cacheSet(key, envelope);
  return envelope;
}

/** "6.1" (6 IP, 1 out) -> 19 outs. */
function ipToOuts(ip) {
  const [whole, frac] = String(ip ?? "0.0").split(".");
  return Number(whole || 0) * 3 + Number(frac || 0);
}
function outsToIP(outs) {
  return Number((outs / 3).toFixed(1));
}

// ---------- helpers ----------
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB API ${res.status} for ${url}`);
  return res.json();
}

/** Fetch many URLs with limited concurrency. Failures become null. */
async function getJSONMany(urls, concurrency = 25) {
  const out = new Array(urls.length).fill(null);
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const idx = i++;
      try {
        out[idx] = await getJSON(urls[idx]);
      } catch {
        out[idx] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once. Unlike
 * getJSONMany, `fn` does its own fetch+fold+discard, so nothing holds every
 * item's full result in memory at the same time — used for the boxscore-heavy
 * jobs where fetching everything up front risks exceeding a 512MB instance.
 */
async function processWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Current hour (0-23) in US Eastern time, for scheduling the daily job around baseball's morning. */
function currentHourET() {
  return Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "America/New_York" }).format(new Date())
  );
}

// ---------- core data assembly (pure computation, no caching in here) ----------
async function computeDashboard(date) {
  const season = date.slice(0, 4);
  const [sched, teamStats, leaders] = await Promise.all([
    getJSON(`${MLB}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team`),
    getJSON(`${MLB}/teams/stats?season=${season}&sportIds=1&group=hitting&stats=season`),
    getJSON(`${MLB}/stats/leaders?leaderCategories=strikeouts&statGroup=pitching&sportId=1&season=${season}&limit=50`),
  ]);

  const games = (sched?.dates?.[0]?.games || []).map((g) => ({
    gamePk: g.gamePk,
    time: g.gameDate,
    status: g.status?.detailedState,
    away: {
      teamId: g.teams?.away?.team?.id,
      name: g.teams?.away?.team?.name,
      pitcher: g.teams?.away?.probablePitcher
        ? { id: g.teams.away.probablePitcher.id, name: g.teams.away.probablePitcher.fullName }
        : null,
    },
    home: {
      teamId: g.teams?.home?.team?.id,
      name: g.teams?.home?.team?.name,
      pitcher: g.teams?.home?.probablePitcher
        ? { id: g.teams.home.probablePitcher.id, name: g.teams.home.probablePitcher.fullName }
        : null,
    },
  }));

  const allTeams = (teamStats?.stats?.[0]?.splits || [])
    .map((s) => ({
      teamId: s.team?.id,
      name: s.team?.name,
      strikeOuts: Number(s.stat?.strikeOuts || 0),
    }))
    .filter((t) => t.teamId)
    .sort((a, b) => b.strikeOuts - a.strikeOuts);

  const topTeams = allTeams.slice(0, 10);
  const bottomTeams = allTeams.slice(-10).reverse();

  const pitchers = (leaders?.leagueLeaders?.[0]?.leaders || []).map((l) => ({
    rank: l.rank,
    personId: l.person?.id,
    name: l.person?.fullName,
    team: l.team?.name,
    strikeOuts: Number(l.value || 0),
  }));

  return { date, games, topTeams, bottomTeams, pitchers };
}

async function computeBvPEdges(date, dash) {
  if (!dash) dash = await computeDashboard(date);

  const MIN_AB = 10;
  const AVG_THRESHOLD = 0.5;
  const K_RATE_THRESHOLD = 0.5;

  // pitcher ↔ opposing-team pairs
  const pairs = [];
  for (const g of dash.games) {
    const label = `${g.away.name} @ ${g.home.name}`;
    if (g.away.pitcher)
      pairs.push({ pitcher: g.away.pitcher, oppTeamId: g.home.teamId, oppName: g.home.name, game: label });
    if (g.home.pitcher)
      pairs.push({ pitcher: g.home.pitcher, oppTeamId: g.away.teamId, oppName: g.away.name, game: label });
  }

  // rosters (one fetch per team involved)
  const teamIds = [...new Set(pairs.map((p) => p.oppTeamId))];
  const rosters = await getJSONMany(teamIds.map((id) => `${MLB}/teams/${id}/roster?rosterType=active`));
  const battersByTeam = {};
  teamIds.forEach((id, i) => {
    battersByTeam[id] = ((rosters[i]?.roster) || [])
      .filter((r) => r.position?.abbreviation !== "P")
      .map((r) => ({ id: r.person.id, name: r.person.fullName }));
  });

  // one vsPlayerTotal lookup per batter/pitcher pair
  const requests = [];
  for (const pair of pairs) {
    for (const batter of battersByTeam[pair.oppTeamId] || []) {
      requests.push({
        url: `${MLB}/people/${batter.id}/stats?stats=vsPlayerTotal&group=hitting&opposingPlayerId=${pair.pitcher.id}`,
        batter,
        pair,
      });
    }
  }
  const results = await getJSONMany(requests.map((r) => r.url));

  const edges = [];
  results.forEach((data, i) => {
    if (!data?.stats) return;
    const { batter, pair } = requests[i];
    let stat = null;
    for (const s of data.stats) {
      for (const sp of s.splits || []) {
        if (sp.stat && sp.stat.atBats !== undefined) stat = sp.stat;
      }
    }
    if (!stat) return;

    const ab = Number(stat.atBats || 0);
    if (ab < MIN_AB) return;
    const hits = Number(stat.hits || 0);
    const ks = Number(stat.strikeOuts || 0);
    const avg = hits / ab;
    const kRate = ks / ab;

    const batterOwns = avg >= AVG_THRESHOLD;
    const pitcherOwns = kRate >= K_RATE_THRESHOLD;
    if (!batterOwns && !pitcherOwns) return;

    edges.push({
      game: pair.game,
      pitcher: pair.pitcher.name,
      batter: batter.name,
      batterTeam: pair.oppName,
      ab,
      hits,
      avg: Number(avg.toFixed(3)),
      strikeOuts: ks,
      kRate: Number((kRate * 100).toFixed(0)),
      edge: batterOwns && pitcherOwns ? "both" : batterOwns ? "batter" : "pitcher",
    });
  });

  edges.sort((a, b) => b.avg - a.avg || b.kRate - a.kRate);
  return { date, edges, checked: requests.length };
}

function kalshiDatePrefix(date) {
  const [y, m, d] = date.split("-").map(Number);
  return `${String(y).slice(2)}${MONTHS[m - 1]}${String(d).padStart(2, "0")}`;
}

/** All open KXMLBKS markets whose event ticker falls on the given date. */
async function getKalshiMarketsForDate(date) {
  const prefix = `${KALSHI_SERIES}-${kalshiDatePrefix(date)}`;
  const out = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const url = `${KALSHI}/markets?series_ticker=${KALSHI_SERIES}&status=open&limit=1000${cursor ? "&cursor=" + cursor : ""}`;
    const data = await getJSON(url);
    out.push(...(data?.markets || []));
    cursor = data?.cursor || "";
    if (!cursor) break;
  }
  return out.filter((m) => m.event_ticker?.startsWith(prefix));
}

function parseKalshiPitcherName(m) {
  return (m.yes_sub_title || m.title || "").replace(/:\s*\d+\+.*$/, "").trim();
}

/** Find a pitcher's game context (team, opponent, time) from the day's schedule. */
function findGameContext(dash, pitcherId) {
  if (!pitcherId) return null;
  for (const g of dash.games) {
    if (g.away.pitcher?.id === pitcherId) return { team: g.away.name, opponent: g.home.name, isHome: false, time: g.time };
    if (g.home.pitcher?.id === pitcherId) return { team: g.home.name, opponent: g.away.name, isHome: true, time: g.time };
  }
  return null;
}

async function computePropBoard(date, dash) {
  if (!dash) dash = await computeDashboard(date);
  const markets = await getKalshiMarketsForDate(date);

  // group Kalshi markets by pitcher name -> { line: marketPct }
  const byPitcher = new Map();
  for (const m of markets) {
    const name = parseKalshiPitcherName(m);
    if (!name) continue;
    const line = Math.round(Number(m.floor_strike) + 0.5);
    if (!PROP_LINES.includes(line)) continue;
    if (!byPitcher.has(name)) byPitcher.set(name, new Map());
    const bid = Number(m.yes_bid_dollars || 0);
    const ask = Number(m.yes_ask_dollars || 0);
    const mid = ask > 0 ? (bid + ask) / 2 : Number(m.last_price_dollars || 0);
    byPitcher.get(name).set(line, Math.round(mid * 100));
  }

  const names = [...byPitcher.keys()];
  const searchResults = await getJSONMany(names.map((n) => `${MLB}/people/search?names=${encodeURIComponent(n)}`));
  const resolved = names.map((n, i) => {
    const people = searchResults[i]?.people || [];
    const person = people.find((p) => p.primaryPosition?.abbreviation === "P") || people[0] || null;
    return { name: n, id: person?.id || null };
  });

  const season = date.slice(0, 4);
  const logIdxs = [];
  const logUrls = [];
  resolved.forEach((r, i) => {
    if (r.id) {
      logIdxs.push(i);
      logUrls.push(`${MLB}/people/${r.id}/stats?stats=gameLog&group=pitching&season=${season}`);
    }
  });
  const logs = await getJSONMany(logUrls);
  const logByIdx = new Map(logIdxs.map((origI, j) => [origI, logs[j]]));

  const pitchers = names.map((name, i) => {
    const r = resolved[i];
    const log = logByIdx.get(i);
    const starts = (log?.stats?.[0]?.splits || []).filter((s) => s.stat?.gamesStarted === 1);
    const kCounts = starts.map((s) => Number(s.stat.strikeOuts || 0));
    const gamesStarted = kCounts.length;
    const ctx = findGameContext(dash, r.id);
    const prices = byPitcher.get(name);

    const lines = PROP_LINES.map((line) => {
      const hits = gamesStarted ? kCounts.filter((k) => k >= line).length : 0;
      return {
        line,
        hits,
        hitRate: gamesStarted ? Math.round((hits / gamesStarted) * 100) : null,
        marketPct: prices.has(line) ? prices.get(line) : null,
      };
    });

    return {
      name,
      mlbId: r.id,
      team: ctx?.team || null,
      opponent: ctx?.opponent || null,
      isHome: ctx?.isHome ?? null,
      time: ctx?.time || null,
      gamesStarted,
      lines,
    };
  });

  pitchers.sort((a, b) => {
    const ta = a.time ? new Date(a.time).getTime() : Infinity;
    const tb = b.time ? new Date(b.time).getTime() : Infinity;
    if (ta !== tb) return ta - tb;
    return a.name.localeCompare(b.name);
  });

  return { date, season, pitchers };
}

/** A pitcher's own average IP / pitches / K per start this season. */
async function getSeasonStartAvg(pitcherId, season) {
  const log = await getJSON(`${MLB}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${season}`);
  const starts = (log?.stats?.[0]?.splits || []).filter((s) => s.stat?.gamesStarted === 1);
  if (!starts.length) return { starts: 0, avgIP: null, avgPitches: null, avgK: null };
  let outsSum = 0, pitchesSum = 0, kSum = 0;
  starts.forEach((s) => {
    outsSum += ipToOuts(s.stat.inningsPitched);
    pitchesSum += Number(s.stat.numberOfPitches || 0);
    kSum += Number(s.stat.strikeOuts || 0);
  });
  return {
    starts: starts.length,
    avgIP: outsToIP(outsSum / starts.length),
    avgPitches: Math.round(pitchesSum / starts.length),
    avgK: Number((kSum / starts.length).toFixed(1)),
  };
}

// ---------- opponent starter workload (how long DO pitchers who face this team usually last) ----------
// Incrementally accumulated per team+season since it requires walking every completed game's boxscore;
// once computed, later requests only need to process newly-completed games.
const workloadCache = new Map(); // "teamId:season" -> { processed: Set<gamePk>, totalOuts, totalPitches, starts, lastChecked }
const WORKLOAD_RECHECK_MS = 3 * 60 * 60 * 1000; // 3 hours
const BOXSCORE_CONCURRENCY = 3; // keep peak boxscores-in-memory low on a 512MB instance

async function getOpponentStarterWorkload(teamId, season) {
  const key = `${teamId}:${season}`;
  let entry = workloadCache.get(key);
  const now = Date.now();
  if (entry && now - entry.lastChecked < WORKLOAD_RECHECK_MS) return summarizeWorkload(entry);
  if (!entry) entry = { processed: new Set(), totalOuts: 0, totalPitches: 0, starts: 0, lastChecked: 0 };

  let sched;
  try {
    sched = await getJSON(`${MLB}/schedule?sportId=1&teamId=${teamId}&season=${season}&gameType=R`);
  } catch {
    entry.lastChecked = now;
    workloadCache.set(key, entry);
    return summarizeWorkload(entry);
  }

  const games = (sched?.dates || []).flatMap((d) => d.games || []);
  const newGamePks = games
    .filter((g) => g.status?.abstractGameState === "Final" && !entry.processed.has(g.gamePk))
    .map((g) => g.gamePk);

  // Fetch + fold + discard one boxscore at a time (bounded concurrency) rather than
  // pulling every game's full boxscore into memory at once before processing any of them.
  if (newGamePks.length) {
    await processWithConcurrency(newGamePks, BOXSCORE_CONCURRENCY, async (gamePk) => {
      let box;
      try {
        box = await getJSON(`${MLB}/game/${gamePk}/boxscore`);
      } catch {
        entry.processed.add(gamePk);
        return;
      }
      entry.processed.add(gamePk);
      const sides = ["home", "away"];
      const oppSide = sides.find((s) => box?.teams?.[s]?.team?.id && box.teams[s].team.id !== teamId);
      if (!oppSide) return;
      const starterId = box.teams[oppSide]?.pitchers?.[0];
      if (!starterId) return;
      const line = box.teams[oppSide]?.players?.["ID" + starterId]?.stats?.pitching;
      if (!line || line.inningsPitched === undefined) return;
      const outs = ipToOuts(line.inningsPitched);
      if (outs <= 0) return;
      entry.totalOuts += outs;
      entry.totalPitches += Number(line.numberOfPitches || 0);
      entry.starts += 1;
      // `box` falls out of scope here — nothing retains the full boxscore payload
    });
  }

  entry.lastChecked = now;
  workloadCache.set(key, entry);
  const summary = summarizeWorkload(entry);
  // Mirror into the shared store as soon as this team is done, so a crash partway
  // through the other opponent teams still leaves this one populated for readers.
  store.workload.byTeam[teamId] = { ...summary, updatedAt: now };
  return summary;
}

function summarizeWorkload(entry) {
  if (!entry.starts) return { starts: 0, avgIP: null, avgPitches: null };
  return {
    starts: entry.starts,
    avgIP: outsToIP(entry.totalOuts / entry.starts),
    avgPitches: Math.round(entry.totalPitches / entry.starts),
  };
}

async function computeWorkloadBoard(date, dash) {
  if (!dash) dash = await computeDashboard(date);
  const season = date.slice(0, 4);

  const legs = [];
  for (const g of dash.games) {
    const label = `${g.away.name} @ ${g.home.name}`;
    if (g.away.pitcher)
      legs.push({ pitcher: g.away.pitcher, team: g.away.name, oppTeamId: g.home.teamId, oppName: g.home.name, game: label, isHome: false, time: g.time });
    if (g.home.pitcher)
      legs.push({ pitcher: g.home.pitcher, team: g.home.name, oppTeamId: g.away.teamId, oppName: g.away.name, game: label, isHome: true, time: g.time });
  }

  const oppTeamIds = [...new Set(legs.map((l) => l.oppTeamId))];
  const [ownAvgs, oppWorkloads] = await Promise.all([
    Promise.all(legs.map((l) => getSeasonStartAvg(l.pitcher.id, season))),
    // Limited concurrency: each team here walks its full-season boxscore history, and
    // running all of them at once is what blew past 512MB on Render. See processWithConcurrency.
    processWithConcurrency(oppTeamIds, 3, (id) => getOpponentStarterWorkload(id, season)),
  ]);
  const oppMap = new Map(oppTeamIds.map((id, i) => [id, oppWorkloads[i]]));

  const pitchers = legs.map((l, i) => ({
    name: l.pitcher.name,
    mlbId: l.pitcher.id,
    team: l.team,
    opponent: l.oppName,
    isHome: l.isHome,
    time: l.time,
    game: l.game,
    own: ownAvgs[i],
    oppAllowed: oppMap.get(l.oppTeamId) || { starts: 0, avgIP: null, avgPitches: null },
  }));

  pitchers.sort((a, b) => {
    const ta = a.time ? new Date(a.time).getTime() : Infinity;
    const tb = b.time ? new Date(b.time).getTime() : Infinity;
    if (ta !== tb) return ta - tb;
    return a.name.localeCompare(b.name);
  });

  return { date, season, pitchers };
}

// ---------- live K watch ----------
async function computeLiveBoard(date, dash, propBoard) {
  if (!dash) dash = await computeDashboard(date);
  if (!propBoard) propBoard = await computePropBoard(date, dash);

  const season = date.slice(0, 4);
  const propByPitcherId = new Map(propBoard.pitchers.filter((p) => p.mlbId).map((p) => [p.mlbId, p]));

  /** Pick the prop line to track pace against: closest to a coin-flip market price, else closest to a 50% hit rate. */
  function primaryLine(pitcherId) {
    const p = propByPitcherId.get(pitcherId);
    if (!p) return null;
    const withMarket = p.lines.filter((l) => l.marketPct !== null);
    const pool = withMarket.length ? withMarket : p.lines.filter((l) => l.hitRate !== null);
    if (!pool.length) return null;
    const scored = pool.map((l) => ({ l, dist: Math.abs((l.marketPct ?? l.hitRate) - 50) }));
    scored.sort((a, b) => a.dist - b.dist);
    return scored[0].l;
  }

  const games = await Promise.all(dash.games.map(async (g) => {
    const needsFeed = !LIVE_STATUSES.has(g.status);
    let feed = null;
    if (needsFeed) {
      try { feed = await getJSON(`${MLB_LIVE}/game/${g.gamePk}/feed/live`); } catch { feed = null; }
    }
    const linescore = feed?.liveData?.linescore || null;
    const boxTeams = feed?.liveData?.boxscore?.teams || null;

    async function buildLeg(pitcher, side) {
      if (!pitcher) return null;
      const line = boxTeams?.[side]?.players?.["ID" + pitcher.id]?.stats?.pitching || null;
      const avg = await getSeasonStartAvg(pitcher.id, season);
      const strikeOuts = line ? Number(line.strikeOuts || 0) : 0;
      const pitches = line ? Number(line.numberOfPitches || 0) : 0;
      const outsRecorded = line ? ipToOuts(line.inningsPitched) : 0;
      let projectedK = null;
      let outsLeftEst = null;
      if (outsRecorded >= 3 && avg.avgIP) {
        const expectedOuts = avg.avgIP * 3;
        projectedK = Math.round((strikeOuts / outsRecorded) * Math.max(expectedOuts, outsRecorded) * 10) / 10;
        outsLeftEst = Math.max(0, Math.round(expectedOuts - outsRecorded));
      }

      const propLine = primaryLine(pitcher.id);
      let pace = null;
      if (propLine) {
        const need = propLine.line - strikeOuts;
        pace = {
          line: propLine.line,
          marketPct: propLine.marketPct,
          hitRate: propLine.hitRate,
          cleared: need <= 0,
          needed: Math.max(0, need),
          outsLeftEst,
        };
      }

      return {
        id: pitcher.id,
        name: pitcher.name,
        strikeOuts,
        pitches,
        inningsPitched: line?.inningsPitched || "0.0",
        avgIP: avg.avgIP,
        avgPitches: avg.avgPitches,
        avgK: avg.avgK,
        starts: avg.starts,
        projectedK,
        pace,
      };
    }

    const [away, home] = await Promise.all([
      buildLeg(g.away.pitcher, "away"),
      buildLeg(g.home.pitcher, "home"),
    ]);

    return {
      gamePk: g.gamePk,
      time: g.time,
      status: g.status,
      abstractState: feed?.gameData?.status?.abstractGameState || (g.status === "Final" ? "Final" : "Preview"),
      inning: linescore ? { num: linescore.currentInning, half: linescore.inningState, outs: linescore.outs } : null,
      away: { name: g.away.name, pitcher: away },
      home: { name: g.home.name, pitcher: home },
    };
  }));

  return { date, games };
}

// ---------- on-demand path (any date other than today) ----------
// Mirrors the old per-date cache behavior: computed lazily, cached for TTL_MS,
// with dashboard reused across the other three boards to avoid duplicate fetches.
function onDemandDashboard(date) {
  return getOrCompute("dash:" + date, TTL_MS, () => computeDashboard(date));
}
function onDemandBvP(date) {
  return getOrCompute("bvp:" + date, TTL_MS, async () => computeBvPEdges(date, (await onDemandDashboard(date)).data));
}
function onDemandProps(date) {
  return getOrCompute("props:" + date, TTL_MS, async () => computePropBoard(date, (await onDemandDashboard(date)).data));
}
function onDemandWorkload(date) {
  return getOrCompute("workload:" + date, TTL_MS, async () => computeWorkloadBoard(date, (await onDemandDashboard(date)).data));
}
function onDemandLive(date) {
  return getOrCompute("live:" + date, TTL_MS, async () => {
    const dash = (await onDemandDashboard(date)).data;
    const props = (await onDemandProps(date)).data;
    return computeLiveBoard(date, dash, props);
  });
}

// ---------- AI parlay picks ----------
// Env var with a safe fallback: everything downstream checks ANTHROPIC_API_KEY and
// degrades gracefully (see getParlayPicks) rather than crashing when it's unset.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
const ANTHROPIC_MODEL = "claude-sonnet-5";

/**
 * Assemble a compact summary from data already sitting in the store — no MLB API
 * calls of its own, so this can be built and tested with no ANTHROPIC_API_KEY at all.
 */
function buildParlaySummary(dash, bvp, workload) {
  const topTeamIds = new Set((dash?.topTeams || []).map((t) => t.teamId));
  const bottomTeamIds = new Set((dash?.bottomTeams || []).map((t) => t.teamId));
  const pitcherById = new Map((dash?.pitchers || []).map((p) => [p.personId, p]));

  const matchups = [];
  for (const g of dash?.games || []) {
    const legs = [
      { p: g.away.pitcher, oppId: g.home.teamId, opp: g.home.name },
      { p: g.home.pitcher, oppId: g.away.teamId, opp: g.away.name },
    ];
    for (const leg of legs) {
      if (!leg.p) continue;
      const stats = pitcherById.get(leg.p.id);
      matchups.push({
        pitcher: leg.p.name,
        opponent: leg.opp,
        seasonK: stats ? stats.strikeOuts : null,
        kRank: stats ? stats.rank : null,
        oppKTier: topTeamIds.has(leg.oppId) ? "top10" : bottomTeamIds.has(leg.oppId) ? "bottom10" : null,
      });
    }
  }

  return {
    topPitcherKLeaders: (dash?.pitchers || []).slice(0, 15).map((p) => ({
      name: p.name, team: p.team, rank: p.rank, seasonK: p.strikeOuts,
    })),
    topKTeams: (dash?.topTeams || []).map((t) => ({ name: t.name, seasonK: t.strikeOuts })),
    bottomKTeams: (dash?.bottomTeams || []).map((t) => ({ name: t.name, seasonK: t.strikeOuts })),
    matchups,
    bvpEdges: (bvp?.edges || []).map((e) => ({
      batter: e.batter, batterTeam: e.batterTeam, pitcher: e.pitcher,
      ab: e.ab, hits: e.hits, avg: e.avg, strikeOuts: e.strikeOuts, kRate: e.kRate, edge: e.edge,
    })),
    inningsPitches: (workload?.pitchers || []).map((p) => ({
      pitcher: p.name, team: p.team, opponent: p.opponent,
      ownAvgIP: p.own.avgIP, ownAvgPitches: p.own.avgPitches, ownStarts: p.own.starts,
      oppAllowedAvgIP: p.oppAllowed.avgIP, oppAllowedAvgPitches: p.oppAllowed.avgPitches, oppAllowedStarts: p.oppAllowed.starts,
    })),
  };
}

/** Code-complete, untestable until ANTHROPIC_API_KEY is set — see buildParlaySummary above for the free-to-test half. */
async function getParlayPicks(summary) {
  if (!ANTHROPIC_API_KEY) {
    return { unavailable: true, reason: "AI picks not configured yet" };
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content:
            "You are analyzing MLB strikeout-prop stats for the day below. " +
            "Identify the 2-4 strongest individual prop legs for a parlay, " +
            "based only on the data given. For each: name the player/prop, " +
            "give a one-sentence statistical reason citing specific numbers " +
            "from the data (keep it to a single sentence), and a confidence " +
            "label (Strong/Moderate/Speculative). No extra commentary — keep " +
            "the total response under 300 words. " +
            "Respond ONLY as JSON: " +
            '{"legs":[{"player":"","prop":"","reasoning":"","confidence":""}]}' +
            "\n\nRespond with ONLY valid JSON, no markdown code fences, no " +
            "explanation before or after. Your entire response must be a " +
            "single JSON object starting with { and ending with }." +
            "\n\nToday's data:\n" + JSON.stringify(summary),
        },
      ],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errBody}`);
  }
  const data = await res.json();
  if (data.stop_reason === "refusal") throw new Error("Anthropic API declined the request");
  if (data.stop_reason === "max_tokens") {
    throw new Error("Truncated at max_tokens — response was cut off before completing");
  }
  const text = data.content.map((b) => b.text || "").join("");
  // Defensive cleanup in case the model wraps the JSON in fences despite being told not to.
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("[refresh] parlay picks JSON parse failed:", e.message);
    console.error("[Parlay] raw response:", text);
    return { error: "AI response was malformed, will retry next refresh" };
  }
}

// ---------- background refresh: in-memory store, kept warm on a schedule ----------
const store = {
  dashboard: { updatedAt: null, data: null },
  props: { updatedAt: null, data: null },
  liveK: { updatedAt: null, data: null },
  bvp: { updatedAt: null, data: null },
  workload: { updatedAt: null, data: null, byTeam: {} },
  parlayPicks: { updatedAt: null, data: null, unavailable: !ANTHROPIC_API_KEY },
};

const HOUR_MS = 60 * 60 * 1000;
const LIVE_CHECK_MS = 3 * 60 * 1000; // 2-5 min band
const DAILY_CHECK_MS = 5 * 60 * 1000;

/** Matchups + team/pitcher K leaders (cheap: 3 calls) and a live-board baseline, refreshed hourly. */
async function refreshDashboardAndProps() {
  const date = todayISO();
  try {
    const dash = await computeDashboard(date);
    store.dashboard = { updatedAt: Date.now(), data: dash };
  } catch (e) {
    console.error("[refresh] dashboard failed:", e.message);
    return; // props/live baseline need a dashboard to build on
  }
  try {
    const props = await computePropBoard(date, store.dashboard.data);
    store.props = { updatedAt: Date.now(), data: props };
  } catch (e) {
    console.error("[refresh] props failed:", e.message);
  }
  try {
    const live = await computeLiveBoard(date, store.dashboard.data, store.props.data);
    store.liveK = { updatedAt: Date.now(), data: live };
  } catch (e) {
    console.error("[refresh] live baseline failed:", e.message);
  }
}

/** Only touches the live board (with real in-game feeds) when a game is actually in progress. */
async function refreshLiveIfInProgress() {
  const date = todayISO();
  let sched;
  try {
    sched = await getJSON(`${MLB}/schedule?sportId=1&date=${date}`);
  } catch (e) {
    console.error("[refresh] live-check schedule fetch failed:", e.message);
    return;
  }
  const games = sched?.dates?.[0]?.games || [];
  const anyLive = games.some((g) => g.status?.abstractGameState === "Live");
  if (!anyLive) return;
  try {
    const live = await computeLiveBoard(date, store.dashboard.data, store.props.data);
    store.liveK = { updatedAt: Date.now(), data: live };
  } catch (e) {
    console.error("[refresh] live refresh failed:", e.message);
  }
}

/** BvP edges + innings/pitches workload — the expensive, hundreds-of-calls boards. Once a day. */
async function refreshDaily() {
  const date = todayISO();
  const dash = store.dashboard.data; // compute*() will fetch its own if this is still null
  try {
    const bvp = await computeBvPEdges(date, dash);
    store.bvp = { updatedAt: Date.now(), data: bvp };
  } catch (e) {
    console.error("[refresh] bvp failed:", e.message);
  }
  console.log("[Innings/Pitches] refresh started");
  try {
    const workload = await computeWorkloadBoard(date, dash);
    // Update in place (not `store.workload = {...}`) so `byTeam` — written into
    // mid-computation by getOpponentStarterWorkload — survives. Replacing the whole
    // object here used to wipe `byTeam`, which made the *next* run's byTeam write
    // throw on undefined and silently fail this job every time after the first.
    store.workload.data = workload;
    store.workload.updatedAt = Date.now();
    console.log("[Innings/Pitches] refresh succeeded");
  } catch (err) {
    console.error("[Innings/Pitches] refresh FAILED:", err.message);
    // Deliberately leave store.workload untouched on failure — the previous
    // good data keeps serving instead of being wiped or left half-written.
  }

  // AI parlay picks — after bvp/workload so the summary reflects today's real numbers.
  // getParlayPicks itself no-ops gracefully when ANTHROPIC_API_KEY isn't set.
  try {
    const summary = buildParlaySummary(dash, store.bvp.data, store.workload.data);
    const result = await getParlayPicks(summary);
    if (result && result.unavailable) {
      store.parlayPicks = { updatedAt: Date.now(), data: null, unavailable: true };
    } else {
      store.parlayPicks = { updatedAt: Date.now(), data: result, unavailable: false };
    }
  } catch (e) {
    console.error("[refresh] parlay picks failed:", e.message);
  }
}

let lastDailyRunDate = null;

async function startupRefresh() {
  await refreshDashboardAndProps();
  await refreshLiveIfInProgress();
  await refreshDaily();
  lastDailyRunDate = todayISO();
}
startupRefresh().catch((e) => console.error("[refresh] startup refresh failed:", e.message));

setInterval(() => refreshDashboardAndProps().catch((e) => console.error("[refresh] hourly tick failed:", e.message)), HOUR_MS);
setInterval(() => refreshLiveIfInProgress().catch((e) => console.error("[refresh] live tick failed:", e.message)), LIVE_CHECK_MS);
setInterval(() => {
  const date = todayISO();
  if (currentHourET() === 6 && lastDailyRunDate !== date) {
    lastDailyRunDate = date;
    refreshDaily().catch((e) => console.error("[refresh] daily tick failed:", e.message));
  }
}, DAILY_CHECK_MS);

// ---------- routes ----------
app.get("/api/dashboard", async (req, res) => {
  const date = req.query.date || todayISO();
  try {
    res.json(date === todayISO() ? store.dashboard : await onDemandDashboard(date));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/bvp", async (req, res) => {
  const date = req.query.date || todayISO();
  try {
    res.json(date === todayISO() ? store.bvp : await onDemandBvP(date));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/props", async (req, res) => {
  const date = req.query.date || todayISO();
  try {
    res.json(date === todayISO() ? store.props : await onDemandProps(date));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/live", async (req, res) => {
  const date = req.query.date || todayISO();
  try {
    res.json(date === todayISO() ? store.liveK : await onDemandLive(date));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/workload", async (req, res) => {
  const date = req.query.date || todayISO();
  try {
    res.json(date === todayISO() ? store.workload : await onDemandWorkload(date));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// AI parlay picks: today-only, computed once a day in the background — pure read, no date param.
app.get("/api/parlay-picks", (req, res) => {
  res.json(store.parlayPicks);
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Strikeout Watch running at http://localhost:${PORT}`);
});
