// Runs off the main thread: scans ~/.claude/projects/**/*.jsonl and aggregates
// Claude Code token usage per day, plus an approximate cost estimate.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

// Approximate Anthropic pricing, USD per 1M tokens. Cost is an estimate only.
const PRICING = {
  opus:   { in: 15, out: 75, cw: 18.75, cr: 1.5 },
  sonnet: { in: 3,  out: 15, cw: 3.75,  cr: 0.3 },
  haiku:  { in: 1,  out: 5,  cw: 1.25,  cr: 0.1 },
  fable:  { in: 3,  out: 15, cw: 3.75,  cr: 0.3 },
};
function priceFor(model = '') {
  const m = model.toLowerCase();
  if (m.includes('opus')) return PRICING.opus;
  if (m.includes('haiku')) return PRICING.haiku;
  if (m.includes('fable')) return PRICING.fable;
  return PRICING.sonnet;
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
}

function localDay(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const days = new Map(); // 'YYYY-MM-DD' -> { tokens, cost, msgs }
let totalTokens = 0, totalCost = 0, totalMsgs = 0;

const files = [];
walk(workerData.dir, files);

for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
  for (const line of text.split('\n')) {
    if (!line.includes('input_tokens')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    const msg = rec.message || {};
    const u = msg.usage || rec.usage;
    if (!u || typeof u.input_tokens !== 'number') continue;

    const inp = u.input_tokens || 0;
    const out = u.output_tokens || 0;
    const cw = u.cache_creation_input_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    const tokens = inp + out + cw + cr;

    const p = priceFor(msg.model);
    const cost = (inp * p.in + out * p.out + cw * p.cw + cr * p.cr) / 1e6;

    const key = localDay(rec.timestamp || Date.now());
    const bucket = days.get(key) || { tokens: 0, cost: 0, msgs: 0 };
    bucket.tokens += tokens;
    bucket.cost += cost;
    bucket.msgs += 1;
    days.set(key, bucket);

    totalTokens += tokens;
    totalCost += cost;
    totalMsgs += 1;
  }
}

const todayKey = localDay(Date.now());
const today = days.get(todayKey) || { tokens: 0, cost: 0, msgs: 0 };

// Rolling 7-day window ending today.
const sortedKeys = [...days.keys()].sort();
const dayMs = 86400000;
const now = Date.now();
let weekTokens = 0, weekCost = 0;
for (const [k, v] of days) {
  const age = (now - new Date(k + 'T00:00:00').getTime());
  if (age >= 0 && age < 7 * dayMs) { weekTokens += v.tokens; weekCost += v.cost; }
}

// Peaks so the meters have a self-calibrating ceiling.
let peakDay = 0;
for (const v of days.values()) peakDay = Math.max(peakDay, v.tokens);

let peakWeek = 0;
for (let i = 0; i < sortedKeys.length; i++) {
  const end = new Date(sortedKeys[i]).getTime();
  let sum = 0;
  for (let j = i; j >= 0; j--) {
    const t = new Date(sortedKeys[j]).getTime();
    if (end - t >= 7 * dayMs) break;
    sum += days.get(sortedKeys[j]).tokens;
  }
  peakWeek = Math.max(peakWeek, sum);
}

parentPort.postMessage({
  today: { tokens: today.tokens, cost: today.cost, msgs: today.msgs },
  week: { tokens: weekTokens, cost: weekCost },
  total: { tokens: totalTokens, cost: totalCost, msgs: totalMsgs, days: days.size },
  peakDay,
  peakWeek: peakWeek || weekTokens,
});
