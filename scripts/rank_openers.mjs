/**
 * Rank opening words by the guesses they actually cost, over every historical
 * Wordle answer.
 *
 * Produces a generous candidate pool rather than a precise top-10: downstream
 * questions like "best opener containing no repeated letters" need a set wide
 * enough that the real answer is inside it.
 *
 *   node scripts/rank_openers.mjs [candidates] [keep]
 *     candidates  how many openers to evaluate, by one-ply entropy (default 600)
 *     keep        how many to write out (default 150)
 *
 * Writes data/openers.csv.
 *
 * A game is fully determined by its opener, so answers sharing a feedback
 * pattern share every later state. Walking states rather than replaying games
 * collapses 2,309 games into a few hundred decisions, and reproduces
 * scripts/eval.mjs exactly when every word is available at each decision.
 *
 * Two stages, because fidelity is expensive. Each decision ranks the surviving
 * candidates plus a pool of strong probes; drawing on all 14,855 words costs
 * ~19s per opener, against ~1s with a 1,000-word pool. The cheap pass is only
 * used to shortlist -- it biases means upward by ~0.09 guesses and inflates the
 * worst case, so every reported number comes from the full-fidelity rescore.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { decodeBundle } from '../src/wordle.js';
import {
  POOL_MIN_PRIOR,
  answerPrior,
  createRanker,
  packWords,
  patternOf,
} from '../src/solver.js';

const N_CANDIDATES = Number(process.argv[2]) || 600;
const KEEP = Number(process.argv[3]) || 150;
const SHARD = Number(process.env.SHARD) || 0;
const SHARDS = Number(process.env.SHARDS) || 1;
const SCREEN_PROBES = process.env.SCREEN_PROBES === undefined ? 0 : Number(process.env.SCREEN_PROBES);
const MAX_GUESSES = 12;

const words = decodeBundle(JSON.parse(readFileSync('data/words.json', 'utf8')));
const packed = packWords(words.list);
const answers = readFileSync('data/answers.txt', 'utf8').split('\n').filter(Boolean);

const all = [...Array(words.count).keys()];
const prior = new Float64Array(words.count);
for (let i = 0; i < words.count; i++) prior[i] = answerPrior(words.zipf[i], words.list[i]);
const pool = all.filter((i) => prior[i] >= POOL_MIN_PRIOR);
const targets = answers.map((w) => words.index.get(w)).filter((i) => i !== undefined);

const rank = (S, guesses) => {
  const r = createRanker(packed, guesses, S, Float64Array.from(S, (i) => prior[i]));
  r.step(Infinity);
  return r.result();
};

// One cold-start ranking supplies both the openers to test and the probe pool
// every later decision draws on.
const cold = rank(pool, all);
const openers = cold.slice(0, N_CANDIDATES).map((r) => r.index)
  .filter((_, i) => i % SHARDS === SHARD);
const coldBits = new Map(cold.map((r) => [r.index, r.bits]));

/** Mean guesses this opener costs across every reachable historical answer. */
function evaluate(opener, probes) {
  const decisions = new Map();
  const decide = (S) => {
    const key = S.join(',');
    let d = decisions.get(key);
    if (d === undefined) {
      // Candidates are always available -- a probe-only shortlist can never win.
      d = rank(S, probes === all ? all : [...new Set([...S, ...probes])])[0].index;
      decisions.set(key, d);
    }
    return d;
  };

  let total = 0, unreachable = 0, worst = 0;
  const dist = new Map();

  const walk = (S, live, guess, depth) => {
    if (depth > MAX_GUESSES) { unreachable += live.length; return; }

    const byPattern = new Map();
    for (const a of live) {
      if (a === guess) {
        total += depth;
        worst = Math.max(worst, depth);
        dist.set(depth, (dist.get(depth) ?? 0) + 1);
        continue;
      }
      const p = patternOf(packed, guess, a);
      if (!byPattern.has(p)) byPattern.set(p, []);
      byPattern.get(p).push(a);
    }
    if (byPattern.size === 0) return;

    const splitS = new Map();
    for (const c of S) {
      const p = patternOf(packed, guess, c);
      if (!splitS.has(p)) splitS.set(p, []);
      splitS.get(p).push(c);
    }

    for (const [p, group] of byPattern) {
      const next = splitS.get(p);
      // Answer survives no consistent candidate: it is outside the prior pool.
      if (!next || next.length === 0) { unreachable += group.length; continue; }
      walk(next, group, decide(next), depth + 1);
    }
  };

  walk(pool, targets, opener, 1);

  const solved = targets.length - unreachable;
  const within6 = [...dist.entries()].filter(([g]) => g <= 6).reduce((s, [, n]) => s + n, 0);
  return { mean: total / solved, solved, unreachable, worst, within6 };
}

const t0 = Date.now();

// SCREEN_PROBES=0 disables the cheap pre-pass and rescores every candidate at
// full fidelity. That is the honest default now: the screen was measured
// against WordleBot's published openers and wrongly discarded stare, snare,
// taser and saner -- all inside the top 31 by opening entropy, all comfortably
// inside the true top 120. Openers are separated by hundredths of a turn
// (0.059 across the whole top 120), far below the screen's error, so it
// reordered essentially at random.
let shortlist;
if (SCREEN_PROBES > 0) {
  const screenProbes = cold.slice(0, SCREEN_PROBES).map((r) => r.index);
  console.log(`stage 1: screening ${openers.length} openers against ${targets.length} answers`);
  const screened = [];
  for (const [n, opener] of openers.entries()) {
    screened.push({ opener, ...evaluate(opener, screenProbes) });
    if ((n + 1) % 100 === 0) console.error(`  ${n + 1}/${openers.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  screened.sort((a, b) => a.mean - b.mean);
  shortlist = screened.slice(0, Math.min(screened.length, Math.round(KEEP * 1.4)));
} else {
  shortlist = openers.map((opener) => ({ opener, screened: false }));
}
console.log(`stage 2: rescoring top ${shortlist.length} with every word available`);
const rows = [];
for (const [n, s1] of shortlist.entries()) {
  const r = evaluate(s1.opener, all);
  rows.push({ word: words.list[s1.opener], ...r, bits: coldBits.get(s1.opener), screenRank: n + 1 });
  if ((n + 1) % 25 === 0) console.error(`  ${n + 1}/${shortlist.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
rows.sort((a, b) => a.mean - b.mean || b.within6 - a.within6);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

if (SCREEN_PROBES > 0) {
  const moved = rows.filter((r, i) => Math.abs(r.screenRank - (i + 1)) > 20).length;
  console.log(`${moved}/${rows.length} openers moved more than 20 places between stages\n`);
}

console.log('rank  word    mean   within6   worst   bits');
for (const [n, r] of rows.slice(0, 25).entries()) {
  console.log(
    `${String(n + 1).padStart(4)}  ${r.word}  ${r.mean.toFixed(4)}  ${String(r.within6).padStart(5)}/${r.solved}  ${String(r.worst).padStart(5)}  ${r.bits.toFixed(2)}`,
  );
}

// Shards write partial files; every row is kept so the merge can rank globally.
const keep = SHARDS > 1 ? rows : rows.slice(0, KEEP);
const out = ['word,mean_guesses,solved,within6,worst,opening_bits'];
for (const r of keep) {
  out.push(`${r.word},${r.mean.toFixed(4)},${r.solved},${r.within6},${r.worst},${r.bits.toFixed(2)}`);
}
const path = SHARDS > 1 ? `data/openers.part${SHARD}.csv` : 'data/openers.csv';
writeFileSync(path, out.join('\n') + '\n');
console.log(`\n${path}: ${keep.length} openers`);
