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
 *
 * MLB data is fetched server-side from statsapi.mlb.com (free, no key);
 * prop lines come from Kalshi's public market data API (also free, no key).
 * No CORS issues since everything happens server-side. Results are cached
 * in memory per date so repeat visits are instant and the upstream APIs
 * aren't hammered.
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

// ---------- tiny per-date cache ----------
const cache = new Map(); // key -> { at: ms, data }
const TTL_MS = 30 * 60 * 1000; // 30 minutes
const LIVE_TTL_MS = 20 * 1000; // live board refreshes much faster

function cacheGet(key, ttl = TTL_MS) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  return null;
}
function cacheSet(key, data) {
  cache.set(key, { at: Date.now(), data });
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

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- core data assembly ----------
async function getDashboard(date) {
  const cached = cacheGet("dash:" + date);
  if (cached) return cached;

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

  const data = { date, games, topTeams, bottomTeams, pitchers };
  cacheSet("dash:" + date, data);
  return data;
}

async function getBvPEdges(date) {
  const cached = cacheGet("bvp:" + date);
  if (cached) return cached;

  const MIN_AB = 10;
  const AVG_THRESHOLD = 0.5;
  const K_RATE_THRESHOLD = 0.5;

  const dash = await getDashboard(date);

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
  const out = { date, edges, checked: requests.length };
  cacheSet("bvp:" + date, out);
  return out;
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

async function getPropBoard(date) {
  const cached = cacheGet("props:" + date);
  if (cached) return cached;

  const [dash, markets] = await Promise.all([getDashboard(date), getKalshiMarketsForDate(date)]);

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

  const out = { date, season, pitchers };
  cacheSet("props:" + date, out);
  return out;
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

  if (newGamePks.length) {
    const boxes = await getJSONMany(newGamePks.map((pk) => `${MLB}/game/${pk}/boxscore`));
    boxes.forEach((box, i) => {
      entry.processed.add(newGamePks[i]);
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
    });
  }

  entry.lastChecked = now;
  workloadCache.set(key, entry);
  return summarizeWorkload(entry);
}

function summarizeWorkload(entry) {
  if (!entry.starts) return { starts: 0, avgIP: null, avgPitches: null };
  return {
    starts: entry.starts,
    avgIP: outsToIP(entry.totalOuts / entry.starts),
    avgPitches: Math.round(entry.totalPitches / entry.starts),
  };
}

async function getWorkloadBoard(date) {
  const cached = cacheGet("workload:" + date);
  if (cached) return cached;

  const season = date.slice(0, 4);
  const dash = await getDashboard(date);

  const legs = [];
  for (const g of dash.games) {
    const label = `${g.away.name} @ ${g.home.name}`;
    if (g.away.pitcher)
      legs.push({ pitcher: g.away.pitcher, team: g.away.name, oppTeamId: g.home.teamId, oppName: g.home.name, game: label, isHome: false, time: g.time });
    if (g.home.pitcher)
      legs.push({ pitcher: g.home.pitcher, team: g.home.name, oppTeamId: g.away.teamId, oppName: g.away.name, game: label, isHome: true, time: g.time });
  }

  const [ownAvgs, oppWorkloads] = await Promise.all([
    Promise.all(legs.map((l) => getSeasonStartAvg(l.pitcher.id, season))),
    Promise.all([...new Set(legs.map((l) => l.oppTeamId))].map((id) => getOpponentStarterWorkload(id, season))),
  ]);
  const oppTeamIds = [...new Set(legs.map((l) => l.oppTeamId))];
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

  const out = { date, season, pitchers };
  cacheSet("workload:" + date, out);
  return out;
}

// ---------- live K watch ----------
async function getLiveBoard(date) {
  const cached = cacheGet("live:" + date, LIVE_TTL_MS);
  if (cached) return cached;

  const season = date.slice(0, 4);
  const [dash, propBoard] = await Promise.all([getDashboard(date), getPropBoard(date)]);
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

  const out = { date, games };
  cacheSet("live:" + date, out);
  return out;
}

// ---------- routes ----------
app.get("/api/dashboard", async (req, res) => {
  try {
    res.json(await getDashboard(req.query.date || todayISO()));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/bvp", async (req, res) => {
  try {
    res.json(await getBvPEdges(req.query.date || todayISO()));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/props", async (req, res) => {
  try {
    res.json(await getPropBoard(req.query.date || todayISO()));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/live", async (req, res) => {
  try {
    res.json(await getLiveBoard(req.query.date || todayISO()));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/workload", async (req, res) => {
  try {
    res.json(await getWorkloadBoard(req.query.date || todayISO()));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Strikeout Watch running at http://localhost:${PORT}`);
});
