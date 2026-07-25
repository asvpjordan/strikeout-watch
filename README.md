# Strikeout Watch

Daily MLB strikeout-prop research dashboard. Node/Express backend fetches from
the free MLB Stats API server-side (no CORS issues, no proxies), caches results
for 30 minutes, and serves a single-page dashboard.

## What it shows

- Today's games with probable pitchers, their season K totals and MLB rank
- "Strong K spot" flags (K leader vs. a top-10 strikeout lineup) and
  "Caution" flags (low-strikeout lineup in the game)
- Top 10 / bottom 10 teams by batter strikeouts
- Top 50 pitchers by strikeouts
- Batter-vs-pitcher edges: hitters with 10+ career AB vs a probable pitcher
  who hit .500+ or strike out 50%+ of the time against them

## Run locally

Requires Node.js 18+ (https://nodejs.org).

```
npm install
npm start
```

Then open http://localhost:3000

## Deploy free on Render

1. Push this folder to a GitHub repository.
2. On https://render.com → New → Web Service → connect the repo.
3. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
4. Deploy. You'll get a public URL like https://strikeout-watch.onrender.com

Notes:
- Render's free tier sleeps after inactivity; the first visit of the day takes
  ~30s to wake up, then it's fast. Paid tier ($7/mo) stays always-on.
- No cron job needed: data is fetched fresh (and cached) whenever the page is
  opened, so it's always current.

## Structure

- `server.js` — Express server, MLB API fetching, caching, `/api/dashboard`
  and `/api/bvp` endpoints
- `public/index.html` — the dashboard UI (vanilla JS, no build step)

## Ideas for later

- More prop types (outs recorded, hits allowed, walks)
- Other sports (the pattern is identical: schedule + leaders + matchup flags)
- Odds feed integration to show actual prop lines next to the stats
