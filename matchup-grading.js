/**
 * matchup-grading.js — Tier 1 inputs + deterministic 1-10 matchup grade
 *
 * Two halves:
 *   1. Data enrichment: recent form, workload/rest, team handedness splits,
 *      confirmed lineups.
 *   2. gradeMatchup(): a pure function turning those inputs into a projected
 *      strikeout total and a 1-10 grade.
 *
 * The grade is deliberately NOT an AI call. It's a transparent calculation so
 * you can see exactly why a matchup scored what it did, tune the weights, and
 * get the same answer twice for the same inputs.
 *
 * Self-contained. See INTEGRATION at the bottom.
 */

const MLB = "https://statsapi.mlb.com/api/v1";

// League-average batters faced per inning pitched. Stable ~4.2-4.3 in the
// modern game; used to convert expected innings into expected batters.
const BATTERS_PER_INNING = 4.28;

// Blend weights. These are judgment calls, not derived from anything —
// they're the first thing to tune once the Track Record tab has data.
const W_LAST5_K_RATE = 0.35;   // recent form vs season for K rate
const W_PITCHER_IP = 0.6;      // pitcher's own IP/start vs opponent's allowed

// --------------------------------------------------------------- fetching

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB API ${res.status} for ${url}`);
  return res.json();
}

/** Run an async fn over items with a concurrency cap (memory safety). */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length).fill(null);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx]);
      } catch (err) {
        console.error(`[Grading] item failed:`, err.message);
        out[idx] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** MLB returns innings as "6.1" meaning 6 and 1/3. Convert to a real number. */
function parseIP(ip) {
  if (ip === null || ip === undefined) return 0;
  const [whole, outs] = String(ip).split(".");
  return Number(whole || 0) + Number(outs || 0) / 3;
}

function daysBetween(aISO, bISO) {
  const ms = new Date(bISO + "T00:00:00Z") - new Date(aISO + "T00:00:00Z");
  return Math.round(ms / 86400000);
}

/**
 * Recent form + workload for one pitcher, from a single gameLog call.
 * Covers spec items 1a and 1b together — one fetch, not two.
 */
async function getRecentForm(playerId, season, todayISO) {
  const data = await getJSON(
    `${MLB}/people/${playerId}/stats?stats=gameLog&group=pitching&season=${season}`
  );

  const splits = [];
  for (const s of data?.stats || []) {
    for (const sp of s.splits || []) {
      if (sp?.stat && sp?.date) splits.push(sp);
    }
  }
  if (splits.length === 0) return null;

  // Chronological, then take the most recent starts.
  splits.sort((a, b) => (a.date < b.date ? -1 : 1));
  const starts = splits.filter((s) => Number(s.stat.gamesStarted || 0) > 0);
  if (starts.length === 0) return null;

  const last5 = starts.slice(-5);
  const sum = (arr, f) => arr.reduce((t, s) => t + f(s), 0);

  const last5K = sum(last5, (s) => Number(s.stat.strikeOuts || 0)) / last5.length;
  const last5IP = sum(last5, (s) => parseIP(s.stat.inningsPitched)) / last5.length;
  const last5Pitches =
    sum(last5, (s) => Number(s.stat.numberOfPitches || 0)) / last5.length;
  const last5BF = sum(last5, (s) => Number(s.stat.battersFaced || 0)) / last5.length;

  const seasonK = sum(starts, (s) => Number(s.stat.strikeOuts || 0)) / starts.length;
  const seasonIP = sum(starts, (s) => parseIP(s.stat.inningsPitched)) / starts.length;
  const seasonBF = sum(starts, (s) => Number(s.stat.battersFaced || 0)) / starts.length;

  const lastStart = starts[starts.length - 1];
  const daysRest = daysBetween(lastStart.date, todayISO);

  // Consecutive high pitch counts suggest a shorter leash tonight.
  const last3Pitches = starts
    .slice(-3)
    .map((s) => Number(s.stat.numberOfPitches || 0));
  const heavyWorkload =
    last3Pitches.length === 3 && last3Pitches.every((p) => p >= 100);

  return {
    starts: starts.length,
    last5K: round1(last5K),
    last5IP: round1(last5IP),
    last5Pitches: Math.round(last5Pitches),
    last5BF: round1(last5BF),
    seasonK: round1(seasonK),
    seasonIP: round1(seasonIP),
    seasonBF: round1(seasonBF),
    // Positive = trending better than season norm.
    kTrend: round1(last5K - seasonK),
    daysRest,
    shortRest: daysRest > 0 && daysRest < 5,
    heavyWorkload,
    lastStartDate: lastStart.date,
  };
}

/**
 * Team strikeout rate split by opposing pitcher handedness.
 *
 * VERIFY the exact param names / response shape against MLB's API before
 * trusting this — statSplits/sitCodes is the right idea but this corner of
 * the API is under-documented and may differ from the season-stats endpoints
 * already in use. If the shape is wrong, this returns null and everything
 * downstream falls back to overall team K rate.
 */
async function getTeamHandednessSplits(teamId, season) {
  const data = await getJSON(
    `${MLB}/teams/${teamId}/stats?stats=statSplits&group=hitting` +
      `&sitCodes=vl,vr&season=${season}`
  );

  const out = { vsL: null, vsR: null };
  for (const s of data?.stats || []) {
    for (const sp of s.splits || []) {
      const code = sp?.split?.code;
      const pa = Number(sp?.stat?.plateAppearances || 0);
      const k = Number(sp?.stat?.strikeOuts || 0);
      if (!pa) continue;
      const kRate = k / pa;
      if (code === "vl") out.vsL = { kRate, pa, k };
      if (code === "vr") out.vsR = { kRate, pa, k };
    }
  }
  return out.vsL || out.vsR ? out : null;
}

/**
 * Fetch handedness splits for many teams with a concurrency cap, and derive
 * league averages from the same data — self-updating, no stale constants.
 */
async function getAllTeamSplits(teamIds, season) {
  const results = await mapLimit(teamIds, 3, (id) =>
    getTeamHandednessSplits(id, season)
  );

  const byTeam = {};
  let lPA = 0, lK = 0, rPA = 0, rK = 0;

  teamIds.forEach((id, i) => {
    const split = results[i];
    byTeam[id] = split;
    if (split?.vsL) { lPA += split.vsL.pa; lK += split.vsL.k; }
    if (split?.vsR) { rPA += split.vsR.pa; rK += split.vsR.k; }
  });

  return {
    byTeam,
    leagueAvg: {
      vsL: lPA ? lK / lPA : null,
      vsR: rPA ? rK / rPA : null,
    },
  };
}

/**
 * Confirmed lineups for a date. Only exists ~2-3 hours before first pitch,
 * so this belongs in an afternoon refresh, not the early-morning one.
 * Returns { [gamePk]: { away: bool, home: bool } } indicating confirmation.
 */
async function getLineupStatus(dateISO) {
  const data = await getJSON(
    `${MLB}/schedule?sportId=1&date=${dateISO}&hydrate=lineups`
  );
  const out = {};
  for (const g of data?.dates?.[0]?.games || []) {
    const lu = g.lineups || {};
    out[g.gamePk] = {
      away: Array.isArray(lu.awayPlayers) && lu.awayPlayers.length > 0,
      home: Array.isArray(lu.homePlayers) && lu.homePlayers.length > 0,
    };
  }
  return out;
}

// ---------------------------------------------------------------- grading

/**
 * Turn the inputs into a projected strikeout total and a 1-10 grade.
 * Pure function — no fetching, no side effects, same inputs give same output.
 *
 * @param {object} form            from getRecentForm() (may be null)
 * @param {string} pitchHand       "L" or "R"
 * @param {object} oppSplit        from getTeamHandednessSplits() (may be null)
 * @param {object} leagueAvg       { vsL, vsR } league K rates (may be null)
 * @param {number} oppKRateOverall fallback team K rate if splits unavailable
 * @param {number} oppIPAllowed    opponent's avg IP allowed to opposing
 *                                 starters (from the Innings/Pitches tab)
 * @param {boolean} lineupConfirmed
 */
function gradeMatchup({
  form,
  pitchHand,
  oppSplit,
  leagueAvg,
  oppKRateOverall = null,
  oppIPAllowed = null,
  lineupConfirmed = false,
}) {
  const notes = [];
  let missing = 0;

  // --- No usable history: can't grade. Be explicit rather than guessing. ---
  if (!form || !form.starts) {
    return {
      grade: null,
      projectedK: null,
      notes: ["No completed starts this season — not enough data to grade."],
      dataCompleteness: "none",
    };
  }

  // --- 1. Expected innings ---------------------------------------------
  // Blend the pitcher's own recent/season workload with how long this
  // opponent typically lets starters go.
  const ownIP = form.last5IP * 0.4 + form.seasonIP * 0.6;
  let expectedIP;
  if (oppIPAllowed && oppIPAllowed > 0) {
    expectedIP = ownIP * W_PITCHER_IP + oppIPAllowed * (1 - W_PITCHER_IP);
  } else {
    expectedIP = ownIP;
    missing++;
    notes.push("No opponent innings-allowed data — used pitcher's own average.");
  }

  if (form.shortRest) {
    expectedIP *= 0.92;
    notes.push(`Short rest (${form.daysRest} days) — expected innings trimmed.`);
  }
  if (form.heavyWorkload) {
    expectedIP *= 0.96;
    notes.push("100+ pitches in each of last 3 starts — possible shorter leash.");
  }

  // --- 2. Expected batters faced ---------------------------------------
  // Prefer the pitcher's real BF/start if available; otherwise derive it.
  const bfPerIP =
    form.seasonBF && form.seasonIP
      ? form.seasonBF / form.seasonIP
      : BATTERS_PER_INNING;
  const expectedBF = expectedIP * bfPerIP;

  // --- 3. Pitcher's strikeout rate per batter faced ---------------------
  const seasonKRate =
    form.seasonBF > 0 ? form.seasonK / form.seasonBF : null;
  const last5KRate =
    form.last5BF > 0 ? form.last5K / form.last5BF : null;

  let kPerBF;
  if (seasonKRate && last5KRate) {
    kPerBF = last5KRate * W_LAST5_K_RATE + seasonKRate * (1 - W_LAST5_K_RATE);
    if (form.kTrend >= 1.5) notes.push(`Trending up (+${form.kTrend} K vs season avg).`);
    if (form.kTrend <= -1.5) notes.push(`Trending down (${form.kTrend} K vs season avg).`);
  } else if (seasonKRate) {
    kPerBF = seasonKRate;
    missing++;
  } else {
    return {
      grade: null,
      projectedK: null,
      notes: ["Missing batters-faced data — cannot compute a K rate."],
      dataCompleteness: "none",
    };
  }

  // --- 4. Opponent adjustment (handedness-aware) ------------------------
  let oppMultiplier = 1;
  const handKey = pitchHand === "L" ? "vsL" : "vsR";
  const oppHandRate = oppSplit?.[handKey]?.kRate ?? null;
  const lgHandRate = leagueAvg?.[handKey] ?? null;

  if (oppHandRate && lgHandRate) {
    oppMultiplier = oppHandRate / lgHandRate;
    const pct = ((oppMultiplier - 1) * 100).toFixed(0);
    notes.push(
      `Opponent strikes out ${Math.abs(pct)}% ${oppMultiplier >= 1 ? "more" : "less"} ` +
        `than league average vs ${pitchHand === "L" ? "LHP" : "RHP"}.`
    );
  } else if (oppKRateOverall && lgHandRate) {
    oppMultiplier = oppKRateOverall / lgHandRate;
    missing++;
    notes.push("No handedness split available — used overall team K rate.");
  } else {
    missing++;
    notes.push("No opponent strikeout data — no matchup adjustment applied.");
  }

  // Clamp so one weird split can't produce an absurd projection.
  oppMultiplier = Math.max(0.75, Math.min(1.3, oppMultiplier));

  // --- 5. Projection and grade -----------------------------------------
  const projectedK = expectedBF * kPerBF * oppMultiplier;
  const grade = projectedKToGrade(projectedK);

  if (!lineupConfirmed) {
    notes.push("Lineup not yet confirmed — opponent numbers assume regulars.");
  }

  const dataCompleteness = missing === 0 ? "full" : missing === 1 ? "partial" : "sparse";

  return {
    grade,
    projectedK: round1(projectedK),
    expectedIP: round1(expectedIP),
    expectedBF: Math.round(expectedBF),
    kPerBF: Number(kPerBF.toFixed(3)),
    oppMultiplier: Number(oppMultiplier.toFixed(2)),
    notes,
    dataCompleteness,
  };
}

/**
 * Fixed thresholds, deliberately NOT relative to today's slate — a 7 should
 * mean the same thing on every date. League-average starter sits around
 * 5.2 Ks, so 7+ means projecting meaningfully above average.
 */
function projectedKToGrade(k) {
  if (k >= 8.5) return 10;
  if (k >= 7.75) return 9;
  if (k >= 7.0) return 8;
  if (k >= 6.25) return 7;
  if (k >= 5.75) return 6;
  if (k >= 5.25) return 5;
  if (k >= 4.75) return 4;
  if (k >= 4.25) return 3;
  if (k >= 3.5) return 2;
  return 1;
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

module.exports = {
  getRecentForm,
  getTeamHandednessSplits,
  getAllTeamSplits,
  getLineupStatus,
  gradeMatchup,
  projectedKToGrade,
};

/* ============================================================================
 * INTEGRATION
 * ============================================================================
 *
 * --- A. Daily refresh (morning) --------------------------------------------
 *
 *   const {
 *     getRecentForm, getAllTeamSplits, gradeMatchup
 *   } = require("./matchup-grading");
 *
 *   1. Collect every probable pitcher id from today's games.
 *   2. Fetch recent form with a concurrency cap of 3:
 *        const forms = await mapLimit(pitcherIds, 3, id =>
 *          getRecentForm(id, season, todayISO()));
 *      (mapLimit is exported-adjacent here — either reuse the existing
 *      concurrency helper in server.js or copy this one.)
 *   3. Fetch handedness splits once for all teams playing today:
 *        const { byTeam, leagueAvg } = await getAllTeamSplits(teamIds, season);
 *      Cache these daily — they barely move within a day.
 *   4. Pitcher handedness comes from the probablePitcher hydrate
 *      (person.pitchHand.code). If it's not in the current hydrate, add
 *      `person` to the hydrate string rather than making 30 extra calls.
 *   5. For each starter, call gradeMatchup({...}) and store the result on
 *      that game's entry.
 *
 *   Wrap the whole block in try/catch and log
 *   `[Grading] refresh started/succeeded/failed` — same pattern as
 *   [Innings/Pitches], so a silent failure doesn't sit unnoticed.
 *
 *   Fail soft: if splits or form fail, gradeMatchup still returns a grade
 *   using whatever's available and flags it via dataCompleteness. Do NOT
 *   let a grading failure take down the rest of the refresh.
 *
 * --- B. Afternoon refresh (lineups) ----------------------------------------
 *
 *   getLineupStatus() only works ~2-3 hours before first pitch. Either add a
 *   second scheduled job in the afternoon, or fold it into the Live K Watch
 *   poll that's already running during the day. Re-run gradeMatchup with
 *   lineupConfirmed=true once lineups post — the grade itself won't change,
 *   but the caveat note disappears, which matters for trusting it.
 *
 * --- C. Matchups tab ------------------------------------------------------
 *
 *   Replace the current "Strong K spot" binary flag with the grade:
 *     - Show the 1-10 grade prominently per starter (big number, same
 *       scoreboard treatment as the K totals).
 *     - Highlight 7+ — accent border/background, the way "★ STRONG"
 *       currently works.
 *     - Show projectedK next to the grade ("Grade 8 · proj. 7.2 K") so the
 *       number isn't a black box.
 *     - Put `notes` behind a hover/expand — that's the "why" and it's the
 *       most useful part when deciding whether to trust a grade.
 *     - When grade is null, show "Not enough data" rather than 0 or a dash.
 *     - Indicate dataCompleteness ("partial"/"sparse") visually — a grade
 *       built on missing inputs should not look as authoritative as a full
 *       one.
 *
 *   Keep the existing bottom-10 "tough lineup" caution flag — it's derived
 *   differently and still useful as a fade signal.
 *
 * --- D. AI Parlay picker --------------------------------------------------
 *
 *   Add to each pitcher's entry in the summary sent to Claude — COMPACT
 *   form only, since prompt bloat already caused truncation once:
 *
 *     {
 *       name, seasonK, rank,
 *       grade: 8, projectedK: 7.2,
 *       last5: "7.2 K/start, 94 P/start",
 *       trend: "+1.4 vs season",
 *       oppVsHand: "+12% K vs RHP",
 *       rest: "5 days",
 *       lineupConfirmed: true,
 *       propLine, overOdds, underOdds   // if odds integration is live
 *     }
 *
 *   Update the prompt to reference the grade as a starting point rather than
 *   gospel — something like: "Each pitcher has a computed matchup grade
 *   (1-10) and projected strikeout total. Use these as the primary signal,
 *   but weigh them against the prop line: a grade of 9 against a line that
 *   already prices that in is not an edge. Prefer spots where the projection
 *   and the line disagree."
 *
 *   Keep the existing instruction not to select multiple legs on the same
 *   pitcher, and to return an empty legs array when nothing qualifies.
 *
 * ============================================================================
 * TUNING
 * ============================================================================
 *
 * The weights at the top (W_LAST5_K_RATE, W_PITCHER_IP), the grade
 * thresholds in projectedKToGrade(), and the 0.92/0.96 rest and workload
 * penalties are all judgment calls. They're reasonable starting points, not
 * derived from backtesting.
 *
 * Once the Track Record tab has 50+ graded picks, the useful question is
 * whether grade correlates with hit rate at all — if 9s and 6s hit at the
 * same rate, the formula isn't capturing anything and the weights are the
 * first thing to revisit. Log the grade alongside each pick so that
 * comparison is possible later.
 */
