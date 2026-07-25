# Strikeout Watch

Daily MLB strikeout-prop research dashboard. Node/Express backend fetches from
the free MLB Stats API server-side (no CORS issues, no proxies) and serves a
single-page dashboard.

Today's data is refreshed in the background on its own schedule per board (see
below) and kept in an in-memory store — every page load just reads whatever's
already there, so it's instant and never times out waiting on a live fetch.
Browsing a past date via the date picker still fetches on demand and caches
the result for 30 minutes, since that data is static anyway.

| Board | Refresh cadence | Why |
|---|---|---|
| Live K Watch | Every 3 min, only while a game is actually in progress | Changes constantly during live play; not worth polling when nothing's live |
| Matchups / probable pitchers | Hourly | Probables can get announced or changed during the day |
| Team/Pitcher K leaders | Hourly (bundled with matchups — cheap, 3 calls) | Season totals barely move, but the fetch costs nothing extra |
| Prop board (Kalshi lines) | Hourly (bundled with matchups) | Market prices move during the day |
| BvP edges | Daily, ~6am ET | Career stats vs. a probable pitcher barely move day to day; expensive (one fetch per hitter on every active roster) |
| Innings/Pitches | Daily, ~6am ET | Season averages; expensive (walks every opposing starter's boxscore) |
| AI Parlay Picks | Daily, ~6am ET (after BvP/Innings-Pitches) | One Claude API call summarizing the day's numbers into 2-4 suggested parlay legs |

## What it shows

- Today's games with probable pitchers, their season K totals and MLB rank
- "Strong K spot" flags (K leader vs. a top-10 strikeout lineup) and
  "Caution" flags (low-strikeout lineup in the game)
- Top 10 / bottom 10 teams by batter strikeouts
- Top 50 pitchers by strikeouts
- Batter-vs-pitcher edges: hitters with 10+ career AB vs a probable pitcher
  who hit .500+ or strike out 50%+ of the time against them
- AI Parlay Picks: Claude's read on the 2-4 strongest strikeout-prop legs for
  the day, with reasoning and a confidence label (requires an API key — see below)

## Run locally

Requires Node.js 18+ (https://nodejs.org).

```
npm install
npm start
```

Then open http://localhost:3000

### AI Parlay Picks (optional)

The "AI Parlay Picks" tab calls the Anthropic API once a day to turn the day's
stats into a short list of suggested prop legs. It's fully built but shows a
"coming soon" placeholder until you set an API key — no code changes needed
to turn it on:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Export it in your shell before `npm start` for local runs, or set it in
Render's Settings → Environment for the deployed app, then restart/redeploy.
The next scheduled daily refresh (~6am ET) populates real picks automatically.

## Deploy free on Render

1. Push this folder to a GitHub repository.
2. On https://render.com → New → Web Service → connect the repo.
3. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
4. Deploy. You'll get a public URL like https://strikeout-watch.onrender.com

Notes:
- Render's free tier sleeps after ~15 min of no incoming HTTP traffic — and a
  sleeping process means the background scheduler isn't running either. Set
  up a free uptime pinger (UptimeRobot, cron-job.org, etc.) to hit the site's
  URL every 10 minutes so the server (and its background jobs) stay alive.
  The paid tier ($7/mo) never sleeps and is the more reliable option if this
  becomes a daily habit.
- On every server start (deploy or restart), the app immediately runs a full
  refresh in the background so the store isn't empty for the first visitors —
  but BvP and Innings/Pitches can each take a minute or more to populate right
  after a cold start, since they're hundreds of chained API calls. The UI
  shows a "preparing…" message and polls until they're ready.

## Structure

- `server.js` — Express server: MLB/Kalshi API fetching, the background
  refresh scheduler, the in-memory store, and all `/api/*` endpoints
- `public/index.html` — the dashboard UI (vanilla JS, no build step)

## Ideas for later

- More prop types (outs recorded, hits allowed, walks)
- Other sports (the pattern is identical: schedule + leaders + matchup flags)
- Odds feed integration to show actual prop lines next to the stats
