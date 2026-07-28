/**
 * picks-tracking.js — pick logging, grading, and accuracy stats
 *
 * Self-contained. Drop this file next to server.js and wire it in with the
 * four integration points documented at the bottom of this file.
 *
 * Storage: JSON file on disk (./data/picks-log.json).
 * NOTE: Render's disk is ephemeral on some plans — history may be lost on
 * redeploy. See "Persistence caveat" at the bottom.
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const PICKS_LOG_PATH = path.join(DATA_DIR, "picks-log.json");
const MLB = "https://statsapi.mlb.com/api/v1";

// ---------------------------------------------------------------- storage

function loadPicksLog() {
  try {
    const raw = fs.readFileSync(PICKS_LOG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePicksLog(log) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Write to a temp file then rename, so a crash mid-write can't corrupt
    // the existing log.
    const tmp = PICKS_LOG_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(log, null, 2));
    fs.renameSync(tmp, PICKS_LOG_PATH);
    return true;
  } catch (err) {
    console.error("[Picks] failed to save log:", err.message);
    return false;
  }
}

// ---------------------------------------------------------------- helpers

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[.\-']/g, "")
    .replace(/\s+(jr|sr|ii|iii|iv)$/i, "")
    .trim();
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB API ${res.status}`);
  return res.json();
}

/**
 * Build a lookup of normalized pitcher name -> personId from a day's games.
 * `games` is the same shape already stored in store.dashboard.data.games
 * (each with .away.pitcher and .home.pitcher = { id, name }).
 */
function buildPitcherIdMap(games) {
  const map = {};
  for (const g of games || []) {
    for (const side of ["away", "home"]) {
      const p = g?.[side]?.pitcher;
      if (p?.id && p?.name) map[normalizeName(p.name)] = p.id;
    }
  }
  return map;
}

/** Which stat a prop string refers to. Extend here if new prop types are added. */
function propStatKey(prop) {
  const p = String(prop || "").toLowerCase();
  if (p.includes("pitch")) return "numberOfPitches";
  if (p.includes("inning")) return "inningsPitched";
  return "strikeOuts"; // default — K props
}

/** True if the prop is an "under" bet rather than an "over". */
function isUnderProp(prop) {
  return /\bunder\b/i.test(String(prop || ""));
}

// ------------------------------------------------------------- logging

/**
 * Call this right after a successful getParlayPicks() result.
 *
 * @param {object} parlayResult  the parsed { legs: [...] } from the AI call
 * @param {Array}  games         today's games (for resolving player -> id)
 * @param {string} dateISO       YYYY-MM-DD
 */
function logPicks(parlayResult, games, dateISO) {
  const legs = parlayResult?.legs;
  if (!Array.isArray(legs) || legs.length === 0) {
    console.log("[Picks] no legs to log for", dateISO);
    return 0;
  }

  const idMap = buildPitcherIdMap(games);
  const log = loadPicksLog();
  const existingIds = new Set(log.map((p) => p.id));
  let added = 0;
  let unresolved = 0;

  for (const leg of legs) {
    const id = `${dateISO}-${normalizeName(leg.player)}-${normalizeName(leg.prop)}`
      .replace(/\s+/g, "_");

    // Idempotent: re-running the daily job shouldn't duplicate picks.
    if (existingIds.has(id)) continue;

    const playerId = idMap[normalizeName(leg.player)] || null;
    if (!playerId) unresolved++;

    log.push({
      id,
      date: dateISO,
      player: leg.player,
      playerId,                       // needed for grading; null = ungradeable
      prop: leg.prop,
      line: leg.line ?? null,
      odds: leg.odds ?? null,
      confidence: leg.confidence || "Unlabeled",
      reasoning: leg.reasoning || "",
      result: null,
      actual: null,
      gradedAt: null,
    });
    added++;
  }

  savePicksLog(log);
  console.log(
    `[Picks] logged ${added} pick(s) for ${dateISO}` +
      (unresolved ? ` (${unresolved} without a resolvable player id)` : "")
  );
  return added;
}

// ------------------------------------------------------------- grading

/**
 * Fetch a pitcher's game log for the season and return the entry for a date.
 * Returns null if that pitcher has no completed game on that date.
 */
async function getGameLogEntry(playerId, dateISO) {
  const season = dateISO.slice(0, 4);
  const url =
    `${MLB}/people/${playerId}/stats` +
    `?stats=gameLog&group=pitching&season=${season}`;
  const data = await getJSON(url);

  for (const s of data?.stats || []) {
    for (const split of s.splits || []) {
      if (split.date === dateISO) return split;
    }
  }
  return null;
}

/**
 * Grade all ungraded picks whose date is in the past.
 * Safe to run repeatedly — already-graded picks are skipped, and picks whose
 * games haven't finished are left ungraded for the next run.
 */
async function gradePicks(todayISO) {
  const log = loadPicksLog();
  const pending = log.filter(
    (p) => p.result === null && p.date < todayISO && p.playerId
  );

  if (pending.length === 0) {
    console.log("[Picks] nothing to grade");
    return 0;
  }

  console.log(`[Picks] grading ${pending.length} pending pick(s)`);
  let graded = 0;

  // Sequential on purpose — this is a handful of calls per day, and it keeps
  // memory/concurrency pressure off the instance.
  for (const pick of pending) {
    try {
      const entry = await getGameLogEntry(pick.playerId, pick.date);

      // No entry = scratched start, postponement, or game not final yet.
      // Leave ungraded; a later run will pick it up if/when it appears.
      if (!entry?.stat) continue;

      const statKey = propStatKey(pick.prop);
      let actual = entry.stat[statKey];
      if (actual === undefined || actual === null) continue;

      // inningsPitched comes back as a string like "6.1" (6 and 1/3).
      if (statKey === "inningsPitched") {
        const [whole, outs] = String(actual).split(".");
        actual = Number(whole) + (Number(outs || 0) / 3);
      }
      actual = Number(actual);

      pick.actual = actual;
      pick.gradedAt = new Date().toISOString();

      if (pick.line === null || pick.line === undefined) {
        // No line recorded (odds feed missed this pitcher) — we know what
        // happened but not whether it beat a number. Mark explicitly rather
        // than guessing.
        pick.result = "no-line";
      } else if (actual === pick.line) {
        pick.result = "push";
      } else {
        const wentOver = actual > pick.line;
        pick.result = (wentOver !== isUnderProp(pick.prop)) ? "win" : "loss";
      }

      graded++;
    } catch (err) {
      console.error(`[Picks] grading failed for ${pick.id}:`, err.message);
      // Leave ungraded; retried on the next run.
    }
  }

  if (graded > 0) savePicksLog(log);
  console.log(`[Picks] graded ${graded} pick(s)`);
  return graded;
}

// --------------------------------------------------------------- stats

function getPicksStats() {
  const log = loadPicksLog();

  // Only win/loss counts toward accuracy. Pushes, no-line, and ungraded
  // picks are reported separately rather than silently folded in.
  const decided = log.filter((p) => p.result === "win" || p.result === "loss");
  const wins = decided.filter((p) => p.result === "win").length;

  const tiers = ["Strong", "Moderate", "Speculative", "Unlabeled"];
  const byConfidence = {};
  for (const tier of tiers) {
    const tierPicks = decided.filter(
      (p) => String(p.confidence).toLowerCase() === tier.toLowerCase()
    );
    const tierWins = tierPicks.filter((p) => p.result === "win").length;
    if (tierPicks.length === 0 && tier === "Unlabeled") continue;
    byConfidence[tier] = {
      total: tierPicks.length,
      wins: tierWins,
      losses: tierPicks.length - tierWins,
      winRate: tierPicks.length ? tierWins / tierPicks.length : null,
    };
  }

  return {
    overall: {
      decided: decided.length,
      wins,
      losses: decided.length - wins,
      winRate: decided.length ? wins / decided.length : null,
      pending: log.filter((p) => p.result === null).length,
      pushes: log.filter((p) => p.result === "push").length,
      noLine: log.filter((p) => p.result === "no-line").length,
      totalLogged: log.length,
    },
    byConfidence,
    // Most recent first, capped so the response stays small.
    recent: log.slice(-40).reverse(),
    // Sample-size guidance for the UI to display honestly.
    sampleNote:
      decided.length < 50
        ? `Only ${decided.length} graded pick(s) so far — too few to read much into. Accuracy becomes meaningful around 50+.`
        : null,
  };
}

module.exports = { logPicks, gradePicks, getPicksStats, loadPicksLog };
