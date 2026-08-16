#!/usr/bin/env node
/**
 * source-odds.js
 *
 * ⚠️ DOMAIN WARNING — READ BEFORE SETTING UP THE API KEY ⚠️
 * This uses api.the-odds-api.com ("The Odds API", the-odds-api.com).
 * There is a DIFFERENT, similarly-named service at theoddsapi.com
 * ("TheOddsAPI") whose free tier is NBA/MLB only — no football/soccer at
 * all. Signing up at the wrong domain will silently produce a key that
 * can never return anything usable here. Get your key at:
 *   https://the-odds-api.com  (NOT theoddsapi.com)
 *
 * Unlike source-scores.js/source-news.js, this REQUIRES a signup and an
 * API key, stored as a GitHub Actions secret: ODDS_API_KEY. Free tier
 * ("Starter") is 500 credits/month — a credit is markets × regions per
 * call, not "500 requests." This script asks for 1 market (h2h) × 1
 * region (uk) = 1 credit per sport_key polled, once per run.
 *
 * ⚠️ QUOTA WARNING — run this on a SEPARATE, SLOWER schedule than
 * source-scores.js/source-news.js. At the 30-min cadence those two use,
 * 3 leagues would burn 3 × 48/day × 30 = 4,320 credits/month — over 8×
 * the free budget. See .github/workflows/source-odds.yml, which runs
 * every 4 hours by default (3 leagues × 6/day × 30 ≈ 540 — still tight,
 * trim SPORT_KEY_MAP or the interval to fit your actual slate).
 *
 * WHAT IT DOES: reads data/fixtures-watchlist.json, maps each fixture's
 * league to a the-odds-api.com sport_key (SPORT_KEY_MAP below — extend
 * it as needed, same "you fix it, it retries" pattern as unresolved
 * teams), fetches that sport_key's odds ONCE per run (not once per
 * fixture), then matches fixtures to events by team name.
 *
 * OUTPUT — data/odds/{homeSlug}-vs-{awaySlug}.json:
 *   { home: 2.10, draw: 3.40, away: 3.20, bookmaker: "Pinnacle", fetchedAt: "..." }
 * Field names (home/draw/away, decimal odds) deliberately match the
 * Tracker's own manual-odds-entry shape (MarketOddsOverlay / setFixtureOdds)
 * so a future fetchRepoOdds() in the tracker can drop this straight in —
 * that fetch function doesn't exist yet; this script only produces the
 * file for it to eventually read.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURES_PATH = path.join(ROOT, 'data', 'fixtures-watchlist.json');
const ODDS_DIR = path.join(ROOT, 'data', 'odds');
const UNMAPPED_PATH = path.join(ROOT, 'state', 'unmapped-leagues.json');
const UNMATCHED_PATH = path.join(ROOT, 'state', 'unmatched-odds-fixtures.json');

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4'; // the-odds-api.com — see domain warning above
const REGION = process.env.ODDS_REGION || 'uk';
const PREFERRED_BOOKMAKER_KEYS = ['pinnacle', 'bet365', 'williamhill']; // first present wins; falls back to whichever bookmaker the response returns first

// Extend as your slate needs it — each sport_key maps to a list of exact
// league-name aliases (lowercased, trimmed). MATCHING IS EXACT, NOT
// SUBSTRING, ON PURPOSE: an earlier substring version matched "Kenyan
// Premier League" to England's EPL because the text contains "premier
// league" — same trap for Nigerian/Ghanaian/Indian "Premier League"
// competitions. A league with no exact alias match here is skipped and
// logged to state/unmapped-leagues.json rather than silently guessed.
// Sport_keys come from https://api.the-odds-api.com/v4/sports?apiKey=...
const SPORT_KEY_ALIASES = {
  soccer_epl: ['premier league', 'english premier league', 'epl', 'england premier league'],
  soccer_spain_la_liga: ['la liga', 'la liga santander', 'primera division', 'spanish la liga', 'laliga'],
  soccer_italy_serie_a: ['serie a', 'italian serie a'],
  soccer_germany_bundesliga: ['bundesliga', 'german bundesliga'],
  soccer_france_ligue_one: ['ligue 1', 'french ligue 1'],
  soccer_uefa_champs_league: ['champions league', 'uefa champions league', 'ucl'],
  soccer_uefa_europa_league: ['europa league', 'uefa europa league', 'uel'],
  soccer_netherlands_eredivisie: ['eredivisie', 'dutch eredivisie'],
  soccer_portugal_primeira_liga: ['primeira liga', 'portuguese primeira liga', 'liga portugal'],
  soccer_efl_champ: ['championship', 'efl championship', 'english championship'],
  soccer_usa_mls: ['mls', 'major league soccer'],
  soccer_brazil_campeonato: ['brasileirao', 'brazilian serie a', 'campeonato brasileiro'],
  soccer_mexico_ligamx: ['liga mx', 'mexican liga mx'],
};
function sportKeyForLeague(league) {
  const key = (league || '').toLowerCase().trim();
  if (!key) return null;
  for (const [sportKey, aliases] of Object.entries(SPORT_KEY_ALIASES)) {
    if (aliases.includes(key)) return sportKey;
  }
  return null;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Byte-for-byte equivalent to the Tracker's slugifyRepoName() — see the
// same note in source-scores.js/source-news.js. Must stay in sync.
function slugifyRepoName(name) {
  return (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Lenient team-name matcher — the-odds-api.com's own team names ("Man
// United") often won't exactly match what got pasted into the Tracker
// ("Manchester United"). Strips common club suffixes, then checks
// equality, substring containment, or ≥2 shared significant words
// (len>=4) before giving up. Logged misses go to
// state/unmatched-odds-fixtures.json rather than guessing wrong.
function normalizeTeamForMatch(name) {
  return (name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(fc|cf|afc|sc|club|de|the)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamsLikelyMatch(a, b) {
  const na = normalizeTeamForMatch(a);
  const nb = normalizeTeamForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wordsA = new Set(na.split(' ').filter(w => w.length >= 4));
  const wordsB = nb.split(' ').filter(w => w.length >= 4);
  const shared = wordsB.filter(w => wordsA.has(w)).length;
  return shared >= 1 && (wordsA.size <= 2 || shared >= 2); // short names (1-2 tokens) need only 1 shared word; longer names need 2
}

async function fetchOddsForSportKey(sportKey) {
  const url = `${ODDS_API_BASE}/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=${REGION}&markets=h2h&oddsFormat=decimal`;
  const res = await fetch(url);
  const remaining = res.headers.get('x-requests-remaining');
  if (remaining !== null) console.log(`[odds] ${sportKey}: ${remaining} credit(s) remaining this month`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} for ${sportKey} — ${text.slice(0, 200)}`);
  }
  return res.json(); // array of events: { home_team, away_team, bookmakers: [{ key, title, markets: [{ key:'h2h', outcomes:[{name, price}] }] }] }
}

function extractH2H(event) {
  const books = Array.isArray(event.bookmakers) ? event.bookmakers : [];
  let chosen = null;
  for (const preferredKey of PREFERRED_BOOKMAKER_KEYS) {
    chosen = books.find(b => b.key === preferredKey);
    if (chosen) break;
  }
  if (!chosen) chosen = books[0];
  if (!chosen) return null;

  const market = (chosen.markets || []).find(m => m.key === 'h2h');
  if (!market) return null;

  const outcomes = market.outcomes || [];
  const homeOutcome = outcomes.find(o => teamsLikelyMatch(o.name, event.home_team));
  const awayOutcome = outcomes.find(o => teamsLikelyMatch(o.name, event.away_team));
  const drawOutcome = outcomes.find(o => /draw/i.test(o.name));
  if (!homeOutcome || !awayOutcome || !drawOutcome) return null;

  return {
    home: homeOutcome.price,
    draw: drawOutcome.price,
    away: awayOutcome.price,
    bookmaker: chosen.title || chosen.key,
  };
}

async function main() {
  if (!ODDS_API_KEY) {
    console.log('ODDS_API_KEY is not set — skipping odds sourcing entirely (not an error; this step is optional). Set it as a GitHub Actions secret to enable.');
    return;
  }

  const watchlist = readJson(FIXTURES_PATH, { fixtures: [] });
  const fixtures = Array.isArray(watchlist.fixtures) ? watchlist.fixtures : [];
  if (fixtures.length === 0) {
    console.log('fixtures-watchlist.json has no fixtures — nothing to source. Exiting.');
    return;
  }

  const unmapped = [];
  const bySportKey = {};
  for (const fixture of fixtures) {
    const sportKey = sportKeyForLeague(fixture.league);
    if (!sportKey) {
      unmapped.push(fixture.league || '(no league tag)');
      continue;
    }
    (bySportKey[sportKey] = bySportKey[sportKey] || []).push(fixture);
  }
  writeJson(UNMAPPED_PATH, { generatedAt: new Date().toISOString(), unmappedLeagues: [...new Set(unmapped)] });
  if (unmapped.length > 0) {
    console.warn(`Unmapped league(s) — no sport_key, add to SPORT_KEY_ALIASES if you want odds for these: ${[...new Set(unmapped)].join(', ')}`);
  }

  const sportKeys = Object.keys(bySportKey);
  console.log(`Fetching odds for ${sportKeys.length} sport_key(s), covering ${fixtures.length - unmapped.length} of ${fixtures.length} fixture(s)...`);

  let written = 0;
  const unmatchedFixtures = [];

  for (const sportKey of sportKeys) {
    let events;
    try {
      events = await fetchOddsForSportKey(sportKey);
    } catch (e) {
      console.error(`[odds] ${sportKey}: ${e.message}`);
      continue;
    }

    for (const fixture of bySportKey[sportKey]) {
      const event = events.find(ev => teamsLikelyMatch(ev.home_team, fixture.home) && teamsLikelyMatch(ev.away_team, fixture.away));
      if (!event) {
        unmatchedFixtures.push(`${fixture.home} vs ${fixture.away} (${sportKey})`);
        continue;
      }
      const h2h = extractH2H(event);
      if (!h2h) {
        unmatchedFixtures.push(`${fixture.home} vs ${fixture.away} (${sportKey}: event found, no usable h2h market)`);
        continue;
      }
      const pairKey = `${slugifyRepoName(fixture.home)}-vs-${slugifyRepoName(fixture.away)}`;
      writeJson(path.join(ODDS_DIR, `${pairKey}.json`), { ...h2h, fetchedAt: new Date().toISOString() });
      written++;
    }

    await sleep(300); // light pacing between sport_key calls, not credit-relevant but polite
  }

  writeJson(UNMATCHED_PATH, { generatedAt: new Date().toISOString(), unmatchedFixtures });
  if (unmatchedFixtures.length > 0) {
    console.warn(`Fixture(s) with no matching odds event: ${unmatchedFixtures.join(' | ')}`);
  }
  console.log(`Wrote ${written} odds file(s).`);
}

main().catch(err => {
  console.error('source-odds.js failed:', err);
  process.exit(1);
});
