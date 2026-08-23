#!/usr/bin/env node
/**
 * source-conditions.js
 *
 * Reads data/fixtures-watchlist.json (same file source-scores.js and
 * source-news.js already read) and ADDS match-condition bullets to
 * data/live/{home}-vs-{away}.json — same file/shape source-news.js writes,
 * NEVER a competing writer of it. This script must always run AFTER
 * source-news.js in the same job (see source-data.yml): it reads whatever
 * source-news.js just wrote this run, strips only its OWN bullets from a
 * previous run (matched by the [tag] prefixes below), and appends fresh
 * ones — so a single commit ends up with both news and conditions bullets,
 * and neither script's run ever wipes the other's.
 *
 * Covers four Hidden-Factor-Matrix groups nothing else in this repo
 * currently sources:
 *   f12            weather/pitch      Open-Meteo (free, keyless)
 *   f7             injuries/suspensions   API-Football
 *   f8, f16        fixture congestion / rest   API-Football
 *   f9             recent form (goals-for/against proxy, not true xG) API-Football
 *   f14            data-availability confidence   self-computed, no source
 *
 * f6/f10/f11/f15 (stakes, style, referee, manager change) are deliberately
 * NOT duplicated here — source-news.js's free Google News RSS scan already
 * covers that group; adding a paid NewsAPI key on top would just source the
 * same narrative signals twice for no gain.
 *
 * Odds (f13) is deliberately NOT duplicated here either —
 * scripts/source-odds.js already does that properly, with real
 * SPORT_KEY_ALIASES league mapping instead of a generic soccer-wide search,
 * and writes the structured data/odds/*.json shape the Tracker will
 * eventually poll for it.
 *
 * API-Football's free tier is 100 req/day. Each fixture costs up to 3 calls
 * per side (injuries, fixtures, statistics) = up to 6 calls/fixture, PLUS
 * now up to 1 more per side for auto-resolution the first time a team is
 * seen (cached after that, see AUTO-RESOLUTION below). Budget your
 * workflow frequency accordingly.
 *
 * AUTO-RESOLUTION (stage-independence upgrade session): previously, f7/f8/
 * f9/f16 (4 of the ~13 Hidden Factor Matrix factors — the single biggest
 * coverage gap identified when auditing this pipeline) were gated entirely
 * behind a hand-created data/team-meta/{slug}.json file per team, with
 * apiFootballId looked up manually on api-football.com's docs site. That
 * doesn't scale past a handful of teams. This version auto-resolves
 * apiFootballId via API-Football's own /teams?search= endpoint the first
 * time a team is seen, caching the result in
 * state/apifootball-id-cache.json (same pattern as source-scores.js's
 * state/team-id-cache.json for TheSportsDB). A hand-written
 * data/team-meta/{slug}.json entry, if one exists, still takes priority
 * for any field it sets — this is a fallback for teams nobody has
 * hand-configured yet, not a replacement for deliberate overrides.
 *
 * Weather (f12) similarly no longer strictly requires a hand-filled
 * lat/lon: if team-meta has a `city` but no lat/lon, or API-Football's
 * team-search response includes a venue city, this now geocodes that city
 * via Open-Meteo's free, keyless geocoding endpoint and caches the result
 * in state/geocode-cache.json.
 */

const fs = require('fs');
const path = require('path');
const { filterSourceableFixtures } = require('./lib/fixture-window');

const ROOT = path.join(__dirname, '..');
const FIXTURES_PATH = path.join(ROOT, 'data', 'fixtures-watchlist.json');
const LIVE_DIR = path.join(ROOT, 'data', 'live');
const TEAM_META_DIR = path.join(ROOT, 'data', 'team-meta');
const APIFB_CACHE_PATH = path.join(ROOT, 'state', 'apifootball-id-cache.json');
const GEOCODE_CACHE_PATH = path.join(ROOT, 'state', 'geocode-cache.json');

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || '';
// DIAGNOSTIC FIX: API-Football has two separate signup paths that need
// different hosts/headers — sign up directly at api-football.com and your
// key only works against v3.football.api-sports.io with an x-apisports-key
// header (the 'native' default below); sign up via the RapidAPI
// marketplace instead and your key only works against
// api-football-v1.p.rapidapi.com with x-rapidapi-key + x-rapidapi-host
// headers. Pairing the wrong key with the wrong host/header silently 401s
// or 403s — every team fails to resolve, and every fixture ends up with
// 0/4 conditions groups, with nothing in the log to explain why unless the
// response body is printed (see fetchJson below, which now does). Set
// API_FOOTBALL_PROVIDER=rapidapi as a repo Variable if you signed up
// through RapidAPI; defaults to 'native' (api-football.com direct).
const API_FOOTBALL_PROVIDER = (process.env.API_FOOTBALL_PROVIDER || 'native').toLowerCase();
const API_FOOTBALL_BASE = API_FOOTBALL_PROVIDER === 'rapidapi'
  ? 'https://api-football-v1.p.rapidapi.com/v3'
  : 'https://v3.football.api-sports.io';
function apiFootballHeaders() {
  return API_FOOTBALL_PROVIDER === 'rapidapi'
    ? { 'x-rapidapi-key': API_FOOTBALL_KEY, 'x-rapidapi-host': 'api-football-v1.p.rapidapi.com' }
    : { 'x-apisports-key': API_FOOTBALL_KEY };
}
const REQUEST_DELAY_MS = 300;

// Byte-for-byte equivalent to the Tracker's slugifyRepoName() and the copy
// already in source-scores.js / source-news.js — MUST stay in sync across
// all four. A mismatch means this script writes to a filename the Tracker
// never fetches.
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

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} for ${url} — ${body.slice(0, 300)}`);
  }
  return res.json();
}

// =====================================================================
// AUTO-RESOLUTION — apiFootballId via API-Football's own team search,
// cached across runs. Hand-written data/team-meta/{slug}.json still wins
// for any field it explicitly sets; this only fills in what's missing.
// =====================================================================
async function resolveApiFootballTeam(teamName, cache) {
  const key = teamName.trim().toLowerCase();
  if (cache[key]) return cache[key]; // cached hit OR cached miss (id:null) — either way, don't re-query
  if (!API_FOOTBALL_KEY) return null;
  await sleep(REQUEST_DELAY_MS);
  try {
    const url = `${API_FOOTBALL_BASE}/teams?search=${encodeURIComponent(teamName)}`;
    const data = await fetchJson(url, { headers: apiFootballHeaders() });
    const resp = data && Array.isArray(data.response) ? data.response : [];
    if (!resp.length) {
      console.warn(`[apifootball-resolve] ${teamName}: no match — check spelling, or add a manual data/team-meta entry`);
      cache[key] = { id: null, resolvedAt: new Date().toISOString() };
      return cache[key];
    }
    const match = resp[0];
    const entry = {
      id: match.team ? match.team.id : null,
      resolvedName: match.team ? match.team.name : null,
      city: match.venue ? match.venue.city : null,
      resolvedAt: new Date().toISOString(),
    };
    cache[key] = entry;
    return entry;
  } catch (e) {
    console.error(`[apifootball-resolve] ${teamName}: ${e.message}`);
    return null; // network/API error — don't cache a permanent miss for a transient failure
  }
}

// =====================================================================
// AUTO-RESOLUTION — city -> lat/lon via Open-Meteo's free, keyless
// geocoding endpoint, cached across runs. Only called when we have a city
// name but no explicit lat/lon (hand-written team-meta lat/lon always wins).
// =====================================================================
async function geocodeCity(city, cache) {
  const key = city.trim().toLowerCase();
  if (cache[key]) return cache[key];
  await sleep(150);
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`;
    const data = await fetchJson(url);
    const r = data && Array.isArray(data.results) ? data.results[0] : null;
    if (!r) {
      cache[key] = { lat: null, lon: null };
      return cache[key];
    }
    cache[key] = { lat: r.latitude, lon: r.longitude };
    return cache[key];
  } catch (e) {
    console.error(`[geocode] ${city}: ${e.message}`);
    return { lat: null, lon: null };
  }
}

// Merges the hand-written data/team-meta/{slug}.json (if any) with
// auto-resolved apiFootballId/city/lat/lon. Hand-written fields always
// take priority — this only fills gaps, never overrides a deliberate
// manual entry.
async function resolveTeamMeta(teamName, apifbCache, geoCache) {
  const slug = slugifyRepoName(teamName);
  const manual = readJson(path.join(TEAM_META_DIR, `${slug}.json`), {}) || {};
  const meta = { ...manual };

  if (!meta.apiFootballId) {
    const auto = await resolveApiFootballTeam(teamName, apifbCache);
    if (auto && auto.id) {
      meta.apiFootballId = auto.id;
      if (!meta.city && auto.city) meta.city = auto.city;
    }
  }

  if ((typeof meta.lat !== 'number' || typeof meta.lon !== 'number') && meta.city) {
    const geo = await geocodeCity(meta.city, geoCache);
    if (typeof geo.lat === 'number' && typeof geo.lon === 'number') {
      meta.lat = geo.lat;
      meta.lon = geo.lon;
    }
  }

  return meta;
}

// Tracker logs fixture dates as "dd/mm/yy HH:mm" — same format
// fixtures-watchlist.json already uses. Keep in sync if that ever changes.
function parseFixtureDate(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/.exec(String(dateStr).trim());
  if (!m) return null;
  const [, dd, mm, yy, HH, MM] = m;
  return new Date(Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(HH), Number(MM)));
}

function currentSeasonYear() {
  // Rough European-season heuristic (season "2025" = 2025-26). Override
  // per-league via apiFootballLeagueId lookups later if a league's own
  // season numbering differs enough to matter.
  const now = new Date();
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

// =====================================================================
// f12 — Weather. Open-Meteo, free & keyless. Needs the HOME team's
// stadium lat/lon, from team-meta (manual or now auto-geocoded from
// city). Forecast horizon is ~16 days — fixtures further out than that
// correctly get no weather bullet yet.
// =====================================================================
async function sourceWeather(fixture, meta) {
  if (!meta || typeof meta.lat !== 'number' || typeof meta.lon !== 'number') return [];
  const kickoff = parseFixtureDate(fixture.date);
  if (!kickoff) return [];
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${meta.lat}&longitude=${meta.lon}&hourly=temperature_2m,precipitation_probability,wind_speed_10m&forecast_days=16&timezone=UTC`;
    const data = await fetchJson(url);
    if (!data.hourly || !Array.isArray(data.hourly.time)) return [];
    let bestIdx = -1, bestDiff = Infinity;
    data.hourly.time.forEach((t, i) => {
      const diff = Math.abs(new Date(t + 'Z').getTime() - kickoff.getTime());
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    });
    if (bestIdx === -1 || bestDiff > 3 * 3600 * 1000) return [];
    const temp = data.hourly.temperature_2m[bestIdx];
    const rain = data.hourly.precipitation_probability[bestIdx];
    const wind = data.hourly.wind_speed_10m[bestIdx];
    const bullets = [];
    if (typeof temp === 'number') bullets.push(`[weather] Forecast at kickoff: ${Math.round(temp)}°C.`);
    if (typeof rain === 'number' && rain >= 40) bullets.push(`[weather] ${rain}% chance of precipitation around kickoff.`);
    if (typeof wind === 'number' && wind >= 25) bullets.push(`[weather] Windy — ${Math.round(wind)} km/h forecast around kickoff.`);
    return bullets;
  } catch (e) {
    console.error(`[weather] ${fixture.home}: ${e.message}`);
    return [];
  }
}

// =====================================================================
// f7 — Injuries/suspensions. API-Football.
// =====================================================================
async function sourceInjuries(fixture, metaBySide) {
  if (!API_FOOTBALL_KEY) return [];
  const bullets = [];
  for (const side of ['home', 'away']) {
    const meta = metaBySide[side];
    if (!meta || !meta.apiFootballId) continue;
    await sleep(REQUEST_DELAY_MS);
    try {
      const url = `${API_FOOTBALL_BASE}/injuries?team=${meta.apiFootballId}&season=${currentSeasonYear()}`;
      const data = await fetchJson(url, { headers: apiFootballHeaders() });
      const resp = data && Array.isArray(data.response) ? data.response : [];
      if (!resp.length) continue;
      const names = resp.slice(0, 5).map(r => r.player && r.player.name).filter(Boolean);
      if (names.length) {
        bullets.push(`[injuries] ${fixture[side]} injury/suspension list includes: ${names.join(', ')}.`);
      }
    } catch (e) {
      console.error(`[injuries] ${fixture[side]}: ${e.message}`);
    }
  }
  return bullets;
}

// =====================================================================
// f8, f16 — Fixture congestion & rest. API-Football, last 5 fixtures.
// =====================================================================
async function sourceCongestionAndRest(fixture, metaBySide) {
  if (!API_FOOTBALL_KEY) return [];
  const bullets = [];
  const kickoff = parseFixtureDate(fixture.date);
  if (!kickoff) return [];
  for (const side of ['home', 'away']) {
    const meta = metaBySide[side];
    if (!meta || !meta.apiFootballId) continue;
    await sleep(REQUEST_DELAY_MS);
    try {
      const url = `${API_FOOTBALL_BASE}/fixtures?team=${meta.apiFootballId}&last=5`;
      const data = await fetchJson(url, { headers: apiFootballHeaders() });
      const resp = data && Array.isArray(data.response) ? data.response : [];
      if (!resp.length) continue;
      const recentMatches = resp.filter(f => {
        const d = new Date(f.fixture.date);
        const daysAgo = (kickoff - d) / (1000 * 3600 * 24);
        return daysAgo >= 0 && daysAgo <= 14;
      });
      if (recentMatches.length >= 3) {
        bullets.push(`[congestion] ${fixture[side]} have played ${recentMatches.length} matches in the trailing 14 days — possible fixture congestion.`);
      }
      const mostRecent = resp[0];
      if (mostRecent) {
        const daysSince = Math.round((kickoff - new Date(mostRecent.fixture.date)) / (1000 * 3600 * 24));
        if (daysSince >= 0 && daysSince <= 3) {
          bullets.push(`[congestion] ${fixture[side]} played their last match only ${daysSince} day(s) before this fixture — short turnaround.`);
        }
      }
    } catch (e) {
      console.error(`[congestion] ${fixture[side]}: ${e.message}`);
    }
  }
  return bullets;
}

// =====================================================================
// f9 — Recent form as an underlying-quality proxy (goals-for/against +
// form string). Not true xG — understat.com has no official API; swap
// this for a scraper later if that precision turns out to matter.
// =====================================================================
async function sourceTeamForm(fixture, metaBySide) {
  if (!API_FOOTBALL_KEY) return [];
  const bullets = [];
  for (const side of ['home', 'away']) {
    const meta = metaBySide[side];
    if (!meta || !meta.apiFootballId) continue;
    await sleep(REQUEST_DELAY_MS);
    try {
      const league = meta.apiFootballLeagueId || '';
      const url = `${API_FOOTBALL_BASE}/teams/statistics?team=${meta.apiFootballId}&season=${currentSeasonYear()}&league=${league}`;
      const data = await fetchJson(url, { headers: apiFootballHeaders() });
      const resp = data ? data.response : null;
      if (!resp || !resp.form) continue;
      const gf = resp.goals && resp.goals.for && resp.goals.for.average ? resp.goals.for.average.total : '?';
      const ga = resp.goals && resp.goals.against && resp.goals.against.average ? resp.goals.against.average.total : '?';
      bullets.push(`[form] ${fixture[side]} recent form: ${resp.form}. Goals for/against per game: ${gf} / ${ga}.`);
    } catch (e) {
      console.error(`[form] ${fixture[side]}: ${e.message}`);
    }
  }
  return bullets;
}

// =====================================================================
// f14 — Data availability confidence. Self-computed, no external call:
// reflects how much of THIS script's own sourcing actually landed, so
// the matrix's read on this factor is honest about how covered (vs.
// absent) this fixture's conditions data really is.
// =====================================================================
function sourceCoverageNote(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const hit = Object.values(counts).filter(n => n > 0).length;
  const tried = Object.keys(counts).length;
  if (total === 0) return [`[coverage] No conditions data (weather/injuries/congestion/form) found for this fixture this run (0/${tried} groups).`];
  return [`[coverage] Conditions data found from ${hit}/${tried} group(s) this run (${total} note(s)).`];
}

// Prefixes this script owns — used to strip its own bullets from a
// previous run before appending fresh ones, without touching bullets
// source-news.js wrote (which carry no bracket prefix).
const OWN_TAGS = ['[weather]', '[injuries]', '[congestion]', '[form]', '[coverage]'];
function isOwnBullet(bullet) {
  return typeof bullet === 'string' && OWN_TAGS.some(tag => bullet.startsWith(tag));
}

async function main() {
  const watchlist = readJson(FIXTURES_PATH, { fixtures: [] });
  const allFixtures = Array.isArray(watchlist.fixtures) ? watchlist.fixtures : [];
  const fixtures = filterSourceableFixtures(allFixtures, 'source-conditions');

  if (fixtures.length === 0) {
    console.log('fixtures-watchlist.json has no fixtures — nothing to source. Exiting.');
    return;
  }

  if (!API_FOOTBALL_KEY) {
    console.warn('API_FOOTBALL_KEY not set — injuries/congestion/form (and auto-resolution) will be skipped for every fixture (weather still runs if lat/lon is already known — it needs no key).');
  }

  const apifbCache = readJson(APIFB_CACHE_PATH, {});
  const geoCache = readJson(GEOCODE_CACHE_PATH, {});

  console.log(`Sourcing conditions for ${fixtures.length} fixture(s)...`);
  let written = 0;
  const seenPairs = new Set();
  const resolvedMetaCache = {}; // teamName -> resolved meta, so each unique team is only resolved once per run

  async function metaFor(teamName) {
    if (resolvedMetaCache[teamName]) return resolvedMetaCache[teamName];
    const meta = await resolveTeamMeta(teamName, apifbCache, geoCache);
    resolvedMetaCache[teamName] = meta;
    return meta;
  }

  for (const fixture of fixtures) {
    if (!fixture.home || !fixture.away) continue;
    const pairKey = `${slugifyRepoName(fixture.home)}-vs-${slugifyRepoName(fixture.away)}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const homeMeta = await metaFor(fixture.home);
    const awayMeta = await metaFor(fixture.away);
    const metaBySide = { home: homeMeta, away: awayMeta };

    const weather = await sourceWeather(fixture, homeMeta);
    const injuries = await sourceInjuries(fixture, metaBySide);
    const congestion = await sourceCongestionAndRest(fixture, metaBySide);
    const form = await sourceTeamForm(fixture, metaBySide);
    const counts = {
      weather: weather.length,
      injuries: injuries.length,
      congestion: congestion.length,
      form: form.length,
    };
    const coverage = sourceCoverageNote(counts);
    const ownBullets = [...weather, ...injuries, ...congestion, ...form, ...coverage];

    const outPath = path.join(LIVE_DIR, `${pairKey}.json`);
    const existing = readJson(outPath, { bullets: [], fetchedAt: null });
    const existingBullets = Array.isArray(existing.bullets) ? existing.bullets : [];
    const keptBullets = existingBullets.filter(b => !isOwnBullet(b));

    writeJson(outPath, {
      bullets: [...keptBullets, ...ownBullets],
      fetchedAt: new Date().toISOString(),
    });
    written++;
  }

  writeJson(APIFB_CACHE_PATH, apifbCache);
  writeJson(GEOCODE_CACHE_PATH, geoCache);

  console.log(`Updated conditions bullets in ${written} live-context file(s).`);
}

main().catch(err => {
  console.error('source-conditions.js failed:', err);
  process.exit(1);
});
