/* The free photo reader's models and what each has left today (R31).
 *
 * Google's free tier gives every model its own allowance, per project:
 * gemini-3.6-flash only 20 requests a day (5 a minute), gemini-3.5-flash-lite
 * 500 a day (15 a minute), as listed by the Service Usage API for this
 * project on 13 and 22 Oct 2026. Before R31 the server counted 600 reads per
 * UTC day while Google stopped at 20, so the page said "ok" all day after the
 * reads had run out. Now each model is counted separately, the day turns
 * over when Google's does (midnight Pacific time), and a 429 from Google is
 * believed over our own count.
 *
 * A 429 is either the per-minute or the per-day limit. Only a per-day answer
 * puts a model aside until tomorrow; a per-minute one rests it for a minute
 * (or Google's own retry delay), so one quick six-page bill cannot switch the
 * main reader off for the day.
 *
 * Counts live in memory, per instance, like the server's other caps: the
 * service runs at most 2 instances, so "reads left" is an estimate, and the
 * screen says "about".
 *
 * Pure: no network, no globals. createQuota({chain, caps, now}) for tests.
 */

// Google's free daily allowances, per model. A model not listed here is
// treated as having the smallest known one until its real figure is added.
const FREE_PER_DAY = { 'gemini-3.6-flash': 20, 'gemini-3.5-flash-lite': 500 };
const UNKNOWN_PER_DAY = 20;
const MINUTE_REST_MS = 60 * 1000;

// Google's quota day: midnight to midnight in Pacific time (it follows US
// daylight saving). Formatted as YYYY-MM-DD.
let PT = null;
try { PT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }); } catch (e) { PT = null; }
function quotaDay(t) {
  const d = new Date(t);
  if (PT) { try { const s = PT.format(d); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; } catch (e) { /* fall through */ } }
  // No time-zone data: Pacific standard time, which is never later than the real one.
  return new Date(t - 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// "gemini-3.6-flash:20,gemini-3.5-flash-lite:500" -> {model: n}
function parseCaps(s) {
  const o = {};
  for (const part of String(s || '').split(',')) {
    const m = /^\s*([^:\s]+)\s*:\s*(\d+)\s*$/.exec(part);
    if (m) o[m[1]] = Number(m[2]);
  }
  return o;
}

// Backup models read only when the main one's free allowance is spent. A
// model goes here only after lib/photo_bench.js has scored it and
// 05_synthetic_corpus/bench/scores.json says it passed (lib/test_reference.js
// checks). Empty at R31's release: the bench could not run, because Google
// refused every call with the server's key (402, "prepayment credits are
// depleted" — the key's project has billing linked; see DEPLOY.md).
// gemini-3.5-flash-lite (500 a day free) is the candidate.
const BACKUP_MODELS = [];

// The chain the server reads with: GEMINI_MODELS if set; otherwise the one
// model in GEMINI_MODEL (the live service sets it) followed by the backups.
function chainFromEnv(env) {
  const list = env.GEMINI_MODELS
    ? env.GEMINI_MODELS.split(',')
    : [env.GEMINI_MODEL || 'gemini-3.6-flash', ...BACKUP_MODELS];
  return [...new Set(list.map(s => s.trim()).filter(Boolean))];
}

// Is this 429 Google's per-day limit? Its body names the quota, for example
// "GenerateRequestsPerDayPerProjectPerModel-FreeTier". Returns the retry
// delay in ms when Google gives one ("retryDelay": "41s").
function readQuotaAnswer(bodyText) {
  const b = String(bodyText || '');
  const perDay = /PerDay/i.test(b);
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(b);
  return { perDay, retryMs: m ? Math.min(Math.round(Number(m[1]) * 1000), 10 * 60 * 1000) : null };
}

function createQuota({ chain, caps, now }) {
  const clock = now || Date.now;
  const book = new Map(chain.map(m => [m, { day: '', used: 0, outDay: '', restUntil: 0, deadDay: '' }]));
  const cap = m => (caps && caps[m] != null ? caps[m] : FREE_PER_DAY[m] != null ? FREE_PER_DAY[m] : UNKNOWN_PER_DAY);
  function entry(m) {
    const e = book.get(m), today = quotaDay(clock());
    if (e.day !== today) { e.day = today; e.used = 0; }
    return { e, today };
  }
  function available(m) {
    const { e, today } = entry(m);
    return e.deadDay !== today && e.outDay !== today && clock() >= e.restUntil && e.used < cap(m);
  }
  const api = {
    chain: chain.slice(),
    cap,
    // The first model that can read right now, or null.
    pick() { return chain.find(available) || null; },
    count(m) { entry(m).e.used++; },
    // Google answered 429 for this model.
    refused(m, bodyText) {
      const { e, today } = entry(m), q = readQuotaAnswer(bodyText);
      if (q.perDay) e.outDay = today;
      else e.restUntil = clock() + (q.retryMs || MINUTE_REST_MS);
    },
    // Google says this model does not exist (404): retired or renamed. Tried
    // again tomorrow, in case it was a passing fault.
    gone(m) { entry(m).e.deadDay = quotaDay(clock()); },
    isGone(m) { return entry(m).e.deadDay === quotaDay(clock()); },
    // Page reads left today across the chain (an estimate: see above).
    left() {
      let n = 0;
      for (const m of chain) {
        const { e, today } = entry(m);
        if (e.deadDay === today || e.outDay === today) continue;
        n += Math.max(0, cap(m) - e.used);
      }
      return n;
    },
    // 'ok' = the main model can read; 'backup' = only a later one can;
    // 'busy' = none can until a limit resets; 'gone' = every model is gone.
    state() {
      const p = api.pick();
      if (p) return p === chain[0] ? 'ok' : 'backup';
      return chain.every(m => api.isGone(m)) ? 'gone' : 'busy';
    },
  };
  return api;
}

module.exports = { createQuota, chainFromEnv, parseCaps, quotaDay, readQuotaAnswer, FREE_PER_DAY, BACKUP_MODELS };
