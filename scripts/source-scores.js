#!/usr/bin/env node
/**
 * source-scores.js
 *
 * Reads data/fixtures-watchlist.json (written by the Tracker via Code.gs's
 * pushFixtures action) and writes two kinds of file, matching EXACTLY what
 * the Tracker's REPO_CONFIG already assumes (see jackpot-tracker's
 * REPO_CONFIG / fetchRepoTeamForm / fetchRepoH2H, "ASSUMED SHAPE" comments
 * above those functions) — this is the contract, not a suggestion:
 *
 *   data/teams/{slug}.json   — that team's own last 5, any competition:
 *     [{ date, opponent, result: 'W'|'D'|'L', score: '2-1', venue: 'home'|'away' }, ...]
 *
 *   data/h2h/{home}-vs-{away}.json — last 5 meetings between these two teams:
 *     [{ date, homeTeam, awayTeam, homeScore, awayScore }, ...]
 *
 * `{slug}` and `{home}-vs-{away}` MUST use the exact same slugify rules as
 * the Tracker's slugifyRepoName() (lowercase, strip diacritics, alnum +
 * hyphens only) — see slugifyRepoName() below, kept byte-for-byte
 * equivalent on purpose so a fetch from the Tracker always resolves to the
 * file this script wrote.
 *
 * Team resolution against TheSportsDB (free/shared test key, no signup) is
 * cached across runs in state/team-id-cache.json.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURES_PATH = path.join(ROOT, 'data', 'fixtures-watchlist.json');
const TEAMS_DIR = path.join(ROOT, 'data', 'teams');
const H2H_DIR = path.join(ROOT, 'data', 'h2h');
const CACHE_PATH = path.join(ROOT, 'state', 'team-id-cache.json');
const UNRESOLVED_PATH = path.join(ROOT, 'state', 'unresolved-teams.json');

const SPORTSDB_KEY = process.env.SPORTSDB_KEY || '123'; // free shared test key, no signup
const SPORTSDB_BASE = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}`;
const REQUEST_DELAY_MS = 1200; // be polite to a shared free-tier key
const LAST_N = 5;

// Byte-for-byte equivalent to the Tracker's slugifyRepoName() — MUST stay
// in sync. If the Tracker's version ever changes, this one has to change
// with it or every fetch will 404.
function slugifyRepoName(name) {
  return (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function resolveTeamId(teamName, cache) {
  const key = teamName.trim().toLowerCase();
  if (cache[key] && cache[key].id) return cache[key];

  await sleep(REQUEST_DELAY_MS);
  const url = `${SPORTSDB_BASE}/searchteams.php?t=${encodeURIComponent(teamName)}`;
  let data;
  try {
    data = await fetchJson(url);
  } catch (e) {
    console.error(`[resolve] ${teamName}: request failed — ${e.message}`);
    return null;
  }

  const team = data && Array.isArray(data.teams) && data.teams.length > 0 ? data.teams[0] : null;
  if (!team) {
    console.warn(`[resolve] ${teamName}: no match on TheSportsDB — check spelling`);
    return null;
  }

  const entry = { id: team.idTeam, resolvedName: team.strTeam, resolvedAt: new Date().toISOString() };
  cache[key] = entry;
  return entry;
}

/**
 * Fetches a team's last 5 results and reshapes them into the Tracker's
 * OWN-PERSPECTIVE shape: { date, opponent, result:'W'|'D'|'L', score, venue }.
 * Unlike a neutral home/away record, this is written from `teamName`'s own
 * point of view — `opponent` is always the other side, `venue` says
 * whether `teamName` itself was playing home or away, and `result` is
 * already W/D/L for `teamName`, not a raw scoreline.
 */
async function teamFormFor(teamName, teamEntry) {
  await sleep(REQUEST_DELAY_MS);
  const url = `${SPORTSDB_BASE}/eventslast.php?id=${teamEntry.id}`;
  let data;
  try {
    data = await fetchJson(url);
  } catch (e) {
    console.error(`[form] ${teamEntry.resolvedName}: request failed — ${e.message}`);
    return [];
  }

  const events = Array.isArray(data.results) ? data.results : [];
  return events
    .filter(ev => ev.intHomeScore !== null && ev.intAwayScore !== null && ev.intHomeScore !== undefined && ev.intAwayScore !== undefined)
    .slice(0, LAST_N)
    .map(ev => {
      const homeScore = Number(ev.intHomeScore);
      const awayScore = Number(ev.intAwayScore);
      const isHome = ev.strHomeTeam === teamEntry.resolvedName;
      const own = isHome ? homeScore : awayScore;
      const opp = isHome ? awayScore : homeScore;
      const result = own > opp ? 'W' : (own < opp ? 'L' : 'D');
      return {
        date: toDDMMYY(ev.dateEvent),
        opponent: isHome ? ev.strAwayTeam : ev.strHomeTeam,
        result,
        score: `${homeScore}-${awayScore}`,
        venue: isHome ? 'home' : 'away',
      };
    });
}

/**
 * Dedicated head-to-head via TheSportsDB's eventsvs.php. This endpoint is
 * one of the methods TheSportsDB's own docs flag as possibly restricted on
 * the free/shared test key — if it comes back empty, that's expected, not
 * a bug. (No fallback is computed here on purpose: the Tracker's own
 * REPO_CONFIG contract for h2hPath is "last 5 dedicated meetings," and a
 * silently-substituted incidental-meeting list would violate that
 * contract. An empty h2h/*.json file just means "not yet covered" to the
 * Tracker's polling loop, which is the correct, honest signal.)
 */
async function h2hFor(homeEntry, awayEntry) {
  await sleep(REQUEST_DELAY_MS);
  const url = `${SPORTSDB_BASE}/eventsvs.php?t1=${homeEntry.id}&t2=${awayEntry.id}`;
  let data;
  try {
    data = await fetchJson(url);
  } catch (e) {
    console.warn(`[h2h] ${homeEntry.resolvedName} vs ${awayEntry.resolvedName}: request failed — ${e.message}`);
    return [];
  }

  const events = Array.isArray(data.event) ? data.event : (Array.isArray(data.events) ? data.events : []);
  return events
    .filter(ev => ev.intHomeScore !== null && ev.intAwayScore !== undefined && ev.intHomeScore !== undefined)
    .sort((a, b) => (b.dateEvent || '').localeCompare(a.dateEvent || ''))
    .slice(0, LAST_N)
    .map(ev => ({
      date: toDDMMYY(ev.dateEvent),
      homeTeam: ev.strHomeTeam,
      awayTeam: ev.strAwayTeam,
      homeScore: Number(ev.intHomeScore),
      awayScore: Number(ev.intAwayScore),
    }));
}

function toDDMMYY(isoDate) {
  if (!isoDate) return null;
  const [yyyy, mm, dd] = isoDate.split('-');
  if (!yyyy || !mm || !dd) return isoDate;
  return `${dd}/${mm}/${yyyy.slice(-2)}`;
}

async function main() {
  const watchlist = readJson(FIXTURES_PATH, { fixtures: [] });
  const fixtures = Array.isArray(watchlist.fixtures) ? watchlist.fixtures : [];

  if (fixtures.length === 0) {
    console.log('fixtures-watchlist.json has no fixtures — nothing to source. Exiting.');
    return;
  }

  const cache = readJson(CACHE_PATH, {});
  const teamNames = [...new Set(fixtures.flatMap(f => [f.home, f.away]).filter(Boolean))];

  console.log(`Resolving ${teamNames.length} unique team(s)...`);
  const resolved = {};
  for (const name of teamNames) {
    resolved[name] = await resolveTeamId(name, cache);
  }
  writeJson(CACHE_PATH, cache);

  const unresolvedTeams = teamNames.filter(name => !resolved[name]);
  writeJson(UNRESOLVED_PATH, { generatedAt: new Date().toISOString(), unresolvedTeams });
  if (unresolvedTeams.length > 0) {
    console.warn(`Unresolved team(s), check spelling against TheSportsDB: ${unresolvedTeams.join(', ')}`);
  }

  console.log('Writing per-team form files...');
  let teamsWritten = 0;
  for (const name of teamNames) {
    const entry = resolved[name];
    if (!entry) continue; // no team file written for an unresolved name — Tracker's fetch 404s and it stays "not yet covered"
    const form = await teamFormFor(name, entry);
    writeJson(path.join(TEAMS_DIR, `${slugifyRepoName(name)}.json`), form);
    teamsWritten++;
  }

  console.log('Writing per-fixture head-to-head files...');
  let h2hWritten = 0;
  const seenPairs = new Set();
  for (const fixture of fixtures) {
    if (!fixture.home || !fixture.away) continue;
    const slugHome = slugifyRepoName(fixture.home);
    const slugAway = slugifyRepoName(fixture.away);
    const pairKey = `${slugHome}-vs-${slugAway}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const homeEntry = resolved[fixture.home];
    const awayEntry = resolved[fixture.away];
    if (!homeEntry || !awayEntry) continue; // unresolved side — no file written, same "not yet covered" reasoning as above

    const h2h = await h2hFor(homeEntry, awayEntry);
    writeJson(path.join(H2H_DIR, `${pairKey}.json`), h2h);
    h2hWritten++;
  }

  console.log(`Wrote ${teamsWritten} team-form file(s) and ${h2hWritten} h2h file(s).`);
}

main().catch(err => {
  console.error('source-scores.js failed:', err);
  process.exit(1);
});
