# Sourcing pipeline

Turns a fixture list into per-team form, per-fixture head-to-head, and
per-fixture live-context files — in the exact shape the Tracker's
`REPO_CONFIG` already assumes. This repo's files are the contract; if
either side changes shape, the other breaks silently (a 404 the Tracker
treats as "not yet covered," not an error), so keep this README and the
Tracker's `REPO_CONFIG` comments in sync.

```
Tracker (paste/load matches)
        │  PUSH FIXTURES → Code.gs (action: pushFixtures) → GitHub Contents API
        ▼
data/fixtures-watchlist.json
        │
        ├─ scripts/source-scores.js → TheSportsDB → data/teams/*.json, data/h2h/*.json
        ├─ scripts/source-news.js   → Google News RSS → data/live/*.json
        ▼
Tracker's background poll (fetchRepoTeamForm / fetchRepoH2H / fetchRepoLiveContext)
        │  fills Stage 1 (additive form/H2H) and Stage 2 (scored live context)
```

## The contract (do not change field names without updating both sides)

**`data/teams/{slug}.json`** — that team's own last 5 results, any
competition, from that team's own point of view:
```json
[{ "date": "08/08/26", "opponent": "Man Utd", "result": "W", "score": "2-1", "venue": "home" }]
```

**`data/h2h/{homeSlug}-vs-{awaySlug}.json`** — last 5 dedicated meetings
between these two teams:
```json
[{ "date": "01/03/26", "homeTeam": "Real Madrid", "awayTeam": "Barcelona", "homeScore": 1, "awayScore": 4 }]
```

**`data/live/{homeSlug}-vs-{awaySlug}.json`** — raw, unscored info. The
Tracker does its own scoring (`scoreRepoLiveContext`) — never put a
side/points/verdict in here:
```json
{ "bullets": ["Arsenal injury update — BBC, 2026-08-15."], "fetchedAt": "2026-08-15T19:18:18.859Z" }
```

**`data/odds/{homeSlug}-vs-{awaySlug}.json`** — 1X2 decimal odds from
one bookmaker (Pinnacle preferred, falls back to whichever the API
returns first). Field names deliberately match the Tracker's own
manual-odds-entry shape:
```json
{ "home": 2.10, "draw": 3.40, "away": 3.20, "bookmaker": "Pinnacle", "fetchedAt": "2026-08-16T04:24:24.444Z" }
```
Optional — only written for fixtures whose `league` has an exact entry
in `SPORT_KEY_ALIASES` (see `source-odds.js`) and `ODDS_API_KEY` is set.
No fetchRepoOdds() exists in the Tracker yet to consume this file — see
the note at the end of this README.

`{slug}` is `slugifyRepoName()` — lowercase, diacritics stripped, alnum +
hyphens only. Both `source-scores.js` and `source-news.js` carry a
byte-for-byte copy of the Tracker's own `slugifyRepoName()`. **If you ever
edit that function in the tracker file, copy the exact same change into
both scripts** — a mismatch means the Tracker fetches a URL these scripts
never wrote, and it silently reads as "no coverage yet."

## Setup

Nothing to configure for scores/news — TheSportsDB uses the free/shared
test key (`123`) and Google News RSS needs no key. Optional env vars (set
as repo Variables): `SPORTSDB_KEY`, `NEWS_LOCALE` (default `en-US`),
`NEWS_COUNTRY` (default `US`).

**Odds is different — it needs a real signup and a GitHub secret.**

⚠️ **Get your key at [the-odds-api.com](https://the-odds-api.com) — NOT
theoddsapi.com.** These are two different services with confusingly
similar names. theoddsapi.com's free tier is NBA/MLB only, no football —
it will never return anything usable here. the-odds-api.com's free
"Starter" plan covers all sports including soccer, no card required.

1. Sign up at the-odds-api.com, copy your API key.
2. Repo Settings > Secrets and variables > Actions > New repository
   secret: name it `ODDS_API_KEY`.
3. That's it — `.github/workflows/source-odds.yml` picks it up
   automatically. Without this secret set, `source-odds.js` just logs
   "skipping" and exits cleanly; nothing breaks.

**Credit budget:** the free tier is 500 credits/month, and a credit is
`markets × regions` per call — not "500 requests." This script asks for
1 market (h2h) × 1 region (uk) = 1 credit per **sport_key** polled per
run (not per fixture — every fixture in the same league shares one
call). That's why odds runs on its own 4-hour-interval workflow instead
of the 30-min one scores/news use: 3 leagues × 6 runs/day × 30 days ≈
540 credits, already close to the cap. If you track more leagues than
that, either stretch the interval in `source-odds.yml` or trim
`SPORT_KEY_ALIASES` in `source-odds.js` to the leagues you actually
need odds for.

## The update loop

1. Someone loads/pastes an upcoming card into the Tracker and clicks
   **PUSH FIXTURES TO REPO**. The Tracker POSTs to Code.gs
   (`action: 'pushFixtures'`), which writes `data/fixtures-watchlist.json`
   here via the GitHub Contents API.
2. That push triggers this workflow immediately (see the `push:` trigger
   on `data/fixtures-watchlist.json`), and it also still runs every 30
   minutes regardless, so already-loaded fixtures keep refreshing.
3. `source-scores.js` resolves each team on TheSportsDB (cached in
   `state/team-id-cache.json`), writes `data/teams/*.json`, and tries a
   dedicated H2H lookup per fixture pair into `data/h2h/*.json`.
4. `source-news.js` writes `data/live/*.json` per fixture.
5. The Tracker's own background poll (already built — see
   `fetchRepoTeamForm`/`fetchRepoH2H`/`fetchRepoLiveContext` and the
   `repoTeamForm`/`repoH2H` polling effect) picks these up with backoff
   until kickoff, per the tracker's own build spec (§2).

## On head-to-head coming back empty

`eventsvs.php` (TheSportsDB's H2H endpoint) is one of the methods flagged
in TheSportsDB's own docs as possibly restricted on the free/shared test
key. An empty `h2h/*.json` is written deliberately rather than silently
substituted with an incidental-meeting scan — the Tracker's own polling
loop already treats "not yet covered" as a legitimate state to keep
retrying (or fall through to partial coverage at kickoff), so a real empty
array is more honest here than smuggling in a different kind of data
under the same field names.

## If a fixture's files never appear

Check `state/unresolved-teams.json` first — almost always a spelling
mismatch between what was pasted into the Tracker and TheSportsDB's own
team name. No `teams/*.json` or `h2h/*.json` file is written for an
unresolved team on purpose (a 404 is the correct "not covered" signal to
the Tracker's poll — writing an empty file for an unresolved name would
look identical to "resolved, but genuinely no data").

For odds specifically, check `state/unmapped-leagues.json` (league text
has no exact `SPORT_KEY_ALIASES` entry) and
`state/unmatched-odds-fixtures.json` (the league mapped fine, but no
event in that sport_key's odds board matched this fixture's team names —
often means the book hasn't posted a line yet, or kickoff is too far
out).

## Odds: repo side is done, Tracker side isn't yet

`source-odds.js` writes `data/odds/*.json`, but the Tracker has no
`fetchRepoOdds()` — odds are still entered manually via the Tracker's
own market-odds paste field. Wiring the Tracker to auto-poll this repo
for odds (mirroring how `fetchRepoTeamForm`/`fetchRepoH2H`/
`fetchRepoLiveContext` already poll for form/H2H/live context) is a
Tracker-side change, not something this repo can do on its own — flag it
for that build session when you're ready for it.
