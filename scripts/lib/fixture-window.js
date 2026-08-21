/**
 * fixture-window.js — shared by all four sourcing scripts
 * (source-scores.js, source-news.js, source-conditions.js, source-odds.js).
 *
 * Once a fixture is inside SOURCING_CUTOFF_MS of kickoff, every sourcing
 * script skips it entirely — no more news scans, no more odds polls, no
 * more injury/weather checks. Reasons this is a hard cutoff, not a "poll
 * less often" throttle:
 *   - The brand's transparency promise is picks logged before kickoff —
 *     there's no legitimate use for data arriving in the last half hour.
 *   - It stops every script from burning free-tier API budget on a
 *     fixture nobody can still act on.
 *   - A late write landing seconds before/after kickoff risks corrupting
 *     that fixture's "before kickoff" record.
 * A fixture with no parseable date fails OPEN (still sourced) — an
 * unparseable date should never silently stop coverage.
 */

const SOURCING_CUTOFF_MS = 30 * 60 * 1000; // 30 minutes

// Same "dd/mm/yy HH:mm" shape used throughout fixtures-watchlist.json.
function parseFixtureDate(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/.exec(String(dateStr).trim());
  if (!m) return null;
  const [, dd, mm, yy, HH, MM] = m;
  return new Date(Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(HH), Number(MM)));
}

// True if this fixture is still outside the pre-kickoff freeze window
// (i.e. still fair game to source). False once within 30 min of kickoff
// or already past it.
function isWithinSourcingWindow(fixture, now) {
  const kickoff = parseFixtureDate(fixture && fixture.date);
  if (!kickoff) return true; // unparseable date — fail open, don't block sourcing
  const nowTime = (now instanceof Date ? now : new Date()).getTime();
  return kickoff.getTime() - nowTime > SOURCING_CUTOFF_MS;
}

// Filters a fixtures array, logging how many got frozen out this run so
// each script's Action log shows why the count is lower than the full
// watchlist without digging into this file.
function filterSourceableFixtures(fixtures, scriptLabel) {
  const list = Array.isArray(fixtures) ? fixtures : [];
  const sourceable = list.filter(f => isWithinSourcingWindow(f));
  const frozen = list.length - sourceable.length;
  if (frozen > 0) {
    console.log(`[${scriptLabel}] ${frozen} fixture(s) inside the 30-min pre-kickoff freeze window — skipped.`);
  }
  return sourceable;
}

module.exports = { parseFixtureDate, isWithinSourcingWindow, filterSourceableFixtures, SOURCING_CUTOFF_MS };
