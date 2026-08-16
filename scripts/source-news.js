#!/usr/bin/env node
/**
 * source-news.js
 *
 * Reads data/fixtures-watchlist.json and writes data/live/{home}-vs-{away}.json
 * per fixture, matching EXACTLY the Tracker's fetchRepoLiveContext assumed
 * shape (see the "ASSUMED SHAPE" comment above fetchRepoLiveContext in the
 * tracker file):
 *
 *   { "bullets": ["short sourced note", ...], "fetchedAt": "ISO-8601 string" }
 *
 * The Tracker does its OWN scoring of these bullets (scoreRepoLiveContext
 * runs them through the same parser used for manually-pasted research) —
 * this script's only job is raw info in, never side/points/verdict. Each
 * bullet is a short, factual, sourced sentence built from a Google News
 * RSS headline: "<title> — <source>, <date>." No scraping, no API key.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURES_PATH = path.join(ROOT, 'data', 'fixtures-watchlist.json');
const LIVE_DIR = path.join(ROOT, 'data', 'live');

const NEWS_LOCALE = process.env.NEWS_LOCALE || 'en-US';
const NEWS_COUNTRY = process.env.NEWS_COUNTRY || 'US';
const REQUEST_DELAY_MS = 500;
const MAX_ITEMS_PER_QUERY = 8;
const MAX_BULLETS_PER_FIXTURE = 12; // team query + team query + fixture query, deduped, capped

// Byte-for-byte equivalent to the Tracker's slugifyRepoName() — see the
// same note in source-scores.js. Must stay in sync.
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

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripCdata(s) {
  const m = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(s.trim());
  return decodeXmlEntities(m ? m[1] : s.trim());
}

function tagValue(itemXml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(itemXml);
  return m ? stripCdata(m[1]) : '';
}

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const itemXml = m[1];
    items.push({
      title: tagValue(itemXml, 'title'),
      link: tagValue(itemXml, 'link'),
      pubDate: tagValue(itemXml, 'pubDate'),
      sourceName: tagValue(itemXml, 'source'),
    });
  }
  return items;
}

async function fetchRss(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${NEWS_LOCALE}&gl=${NEWS_COUNTRY}&ceid=${NEWS_COUNTRY}:${NEWS_LOCALE.split('-')[0]}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; fixture-news-sourcer/1.0)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for news query "${query}"`);
  const xml = await res.text();
  return parseRssItems(xml).slice(0, MAX_ITEMS_PER_QUERY);
}

function itemToBullet(item) {
  const dateStr = item.pubDate ? new Date(item.pubDate).toISOString().slice(0, 10) : '';
  const src = item.sourceName || 'unknown source';
  return dateStr ? `${item.title} — ${src}, ${dateStr}.` : `${item.title} — ${src}.`;
}

async function bulletsForQuery(query) {
  let items;
  try {
    items = await fetchRss(query);
  } catch (e) {
    console.error(`[news] "${query}": ${e.message}`);
    return [];
  }
  return items.filter(i => i.title && i.link).map(i => ({ link: i.link, bullet: itemToBullet(i) }));
}

async function main() {
  const watchlist = readJson(FIXTURES_PATH, { fixtures: [] });
  const fixtures = Array.isArray(watchlist.fixtures) ? watchlist.fixtures : [];

  if (fixtures.length === 0) {
    console.log('fixtures-watchlist.json has no fixtures — nothing to source. Exiting.');
    return;
  }

  console.log(`Sourcing live context for ${fixtures.length} fixture(s)...`);
  let written = 0;
  const seenFixturePairs = new Set();

  for (const fixture of fixtures) {
    if (!fixture.home || !fixture.away) continue;
    const slugHome = slugifyRepoName(fixture.home);
    const slugAway = slugifyRepoName(fixture.away);
    const pairKey = `${slugHome}-vs-${slugAway}`;
    if (seenFixturePairs.has(pairKey)) continue;
    seenFixturePairs.add(pairKey);

    await sleep(REQUEST_DELAY_MS);
    const homeItems = await bulletsForQuery(fixture.home);
    await sleep(REQUEST_DELAY_MS);
    const awayItems = await bulletsForQuery(fixture.away);
    await sleep(REQUEST_DELAY_MS);
    const fixtureItems = await bulletsForQuery(`${fixture.home} ${fixture.away}`);

    const seenLinks = new Set();
    const bullets = [];
    for (const item of [...homeItems, ...awayItems, ...fixtureItems]) {
      if (seenLinks.has(item.link)) continue;
      seenLinks.add(item.link);
      bullets.push(item.bullet);
      if (bullets.length >= MAX_BULLETS_PER_FIXTURE) break;
    }

    writeJson(path.join(LIVE_DIR, `${pairKey}.json`), {
      bullets,
      fetchedAt: new Date().toISOString(),
    });
    written++;
  }

  console.log(`Wrote ${written} live-context file(s).`);
}

main().catch(err => {
  console.error('source-news.js failed:', err);
  process.exit(1);
});
