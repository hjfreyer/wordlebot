/**
 * Precompute (opener, opener-feedback, second) -> expected turns to solve.
 *
 *   node scripts/build_second_book.mjs <openers.txt> [topN] [shard] [shards]
 *
 * Writes data/book/<opener>.json: for each reachable feedback pattern, the
 * candidate count and the best `topN` second guesses with their expected turns.
 *
 * This is the adaptive book -- the second guess is chosen after seeing what the
 * opener revealed, which is worth ~0.37 turns over committing to a fixed pair.
 * Keeping a ranked list rather than only the winner is what lets a constrained
 * question ("best second that avoids these letters") still find an answer.
 *
 * Expected turns counts the opener as turn 1, so a state solved by the second
 * guess scores 2. The expectation is prior-weighted over the candidates in that
 * state, not an average over historical answers: every reachable state has
 * candidates, but a state may contain no historical answer at all, and those
 * that do often contain very few.
 *
 * Continuation is modelled in two passes. Every second is first ranked with a
 * greedy candidates-only tail, which is cheap enough to run across all 14,855;
 * the head of that ranking is then rescored with one ply of lookahead at move
 * three, choosing by expected turns over the candidates plus an entropy
 * shortlist. Only refined numbers are written out.
 *
 * The refinement exists because the cheap tail was measurably wrong. Move-three
 * states are not negligible -- weighted by how often a player lands in them the
 * mean is 11.3 candidates, and 49% of the probability mass sits in states with
 * five or more. Allowing probes there is worth 0.054 turns, and the optimal
 * move-three guess is a non-candidate in 8% of states.
 *
 * The subtlety is that probes must be *chosen* by expected turns and only
 * *shortlisted* by entropy. Picking the highest-entropy guess is worse than
 * ignoring probes altogether (3.986 against 3.911), because with a handful of
 * candidates left the most informative guess is usually not the one that can
 * end the game. Candidates plus the top 300 by entropy recovers 100% of the
 * gain available from searching all 14,855.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { decodeBundle } from '../src/wordle.js';
import {
  POOL_MIN_PRIOR,
  answerPrior,
  createRanker,
  packWords,
  patternOf,
} from '../src/solver.js';

const OPENER_FILE = process.argv[2];
const TOP_N = Number(process.argv[3]) || 50;
// Seconds carried from the cheap ranking into the refined rescore.
const REFINE = Number(process.env.REFINE) || 150;
// Probe shortlist for move-3 decisions. Measured: candidates plus the top 300
// by entropy recovers 100% of the gain from searching all 14,855.
const PROBE_SHORTLIST = Number(process.env.PROBE_SHORTLIST) || 300;
const SHARD = Number(process.argv[4]) || 0;
const SHARDS = Number(process.argv[5]) || 1;
if (!OPENER_FILE) throw new Error('usage: build_second_book.mjs <openers.txt> [topN] [shard] [shards]');

const words = decodeBundle(JSON.parse(readFileSync('data/words.json', 'utf8')));
const packed = packWords(words.list);

const all = [...Array(words.count).keys()];
const prior = new Float64Array(words.count);
for (let i = 0; i < words.count; i++) prior[i] = answerPrior(words.zipf[i], words.list[i]);
const pool = all.filter((i) => prior[i] >= POOL_MIN_PRIOR);

const patternName = (p) => {
  const out = [];
  for (let i = 0, x = p; i < 5; i++, x = (x / 3) | 0) out.push('.yG'[x % 3]);
  return out.join('');
};

const bestGuess = (S) => {
  const r = createRanker(packed, S, S, Float64Array.from(S, (i) => prior[i]));
  r.step(Infinity);
  return r.result()[0].index;
};

const entropyShortlist = (S, n) => {
  const r = createRanker(packed, all, S, Float64Array.from(S, (i) => prior[i]));
  r.step(Infinity);
  return r.result().slice(0, n).map((x) => x.index);
};

/**
 * Weighted turns from S choosing the guess that minimises expected turns,
 * rather than the one that maximises information.
 *
 * Probes are eligible here and they matter: at move three the optimal guess is
 * a non-candidate in 8% of states, worth 0.054 turns. Picking by entropy
 * instead is actively worse than ignoring probes altogether (3.986 against
 * 3.911), because with a handful of candidates left the informative guess is
 * usually not the one that ends the game. Shortlisting by entropy and then
 * choosing by turns gets the full benefit.
 */
function turnsByLookahead(S, W, depth, decisions) {
  if (S.length === 0) return 0;
  if (S.length === 1) return W[0] * depth;
  if (S.length === 2) {
    const hi = W[0] >= W[1] ? 0 : 1;
    return W[hi] * depth + W[1 - hi] * (depth + 1);
  }

  const eligible = [...new Set([...S, ...entropyShortlist(S, PROBE_SHORTLIST)])];
  let best = Infinity;
  for (const g of eligible) {
    let total = 0;
    const byPattern = new Map();
    for (let i = 0; i < S.length; i++) {
      if (S[i] === g) { total += W[i] * depth; continue; }
      const p = patternOf(packed, g, S[i]);
      let b = byPattern.get(p);
      if (!b) byPattern.set(p, (b = { idx: [], w: [] }));
      b.idx.push(S[i]); b.w.push(W[i]);
    }
    // Below this node the tail stays greedy -- the lookahead is one ply deep.
    for (const b of byPattern.values()) {
      total += turnsFrom(b.idx, Float64Array.from(b.w), depth + 1, decisions);
    }
    if (total < best) best = total;
  }
  return best;
}

/**
 * Prior-weighted SUM of turns (not a mean) to finish from candidate set S,
 * playing greedily, where `depth` is the turn about to be spent.
 *
 * `decisions` is keyed by candidate set and shared across every second guess
 * for the same state -- the sub-states that different seconds produce overlap
 * heavily, and without that reuse this is the whole cost of the build.
 */
function turnsFrom(S, W, depth, decisions) {
  if (S.length === 0) return 0;
  if (S.length === 1) return W[0] * depth;

  // Two candidates: guess the likelier one, and if wrong the other is forced.
  // No probe can beat that, so there is nothing to rank and nothing to cache.
  // Most sub-states are this small, and memoising them was the dominant cost --
  // building a string key per node swamped the work it saved.
  if (S.length === 2) {
    const hi = W[0] >= W[1] ? 0 : 1;
    return W[hi] * depth + W[1 - hi] * (depth + 1);
  }

  const key = S.join(',');
  let guess = decisions.get(key);
  if (guess === undefined) {
    guess = bestGuess(S);
    decisions.set(key, guess);
  }

  let total = 0;
  const byPattern = new Map();
  for (let i = 0; i < S.length; i++) {
    if (S[i] === guess) { total += W[i] * depth; continue; }
    const p = patternOf(packed, guess, S[i]);
    let b = byPattern.get(p);
    if (!b) byPattern.set(p, (b = { idx: [], w: [] }));
    b.idx.push(S[i]); b.w.push(W[i]);
  }
  for (const b of byPattern.values()) {
    total += turnsFrom(b.idx, Float64Array.from(b.w), depth + 1, decisions);
  }
  return total;
}

/** Expected turns if `second` is played into state S at turn 2. */
function scoreSecond(S, W, totalWeight, second, decisions, refined = false) {
  let total = 0;
  const byPattern = new Map();
  for (let i = 0; i < S.length; i++) {
    if (S[i] === second) { total += W[i] * 2; continue; }
    const p = patternOf(packed, second, S[i]);
    let b = byPattern.get(p);
    if (!b) byPattern.set(p, (b = { idx: [], w: [] }));
    b.idx.push(S[i]); b.w.push(W[i]);
  }
  for (const b of byPattern.values()) {
    total += refined
      ? turnsByLookahead(b.idx, Float64Array.from(b.w), 3, decisions)
      : turnsFrom(b.idx, Float64Array.from(b.w), 3, decisions);
  }
  return total / totalWeight;
}

function buildOpener(word) {
  const opener = words.index.get(word);
  if (opener === undefined) throw new Error(`opener "${word}" is not in the word list`);

  const states = new Map();
  for (const c of pool) {
    const p = patternOf(packed, opener, c);
    if (!states.has(p)) states.set(p, []);
    states.get(p).push(c);
  }

  const out = [];
  for (const [pattern, S] of [...states.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const W = Float64Array.from(S, (i) => prior[i]);
    const totalWeight = W.reduce((a, b) => a + b, 0);

    // One candidate left: the answer is known and every other guess wastes a turn.
    if (S.length === 1) {
      out.push({
        pattern, key: patternName(pattern), candidates: 1,
        best: [[words.list[S[0]], 2]],
      });
      continue;
    }

    // Rank every second cheaply, then rescore the head with move-3 lookahead.
    // Refining all 14,855 is unaffordable; refining only what gets kept is not.
    const decisions = new Map();
    const scored = all.map((second) => [second, scoreSecond(S, W, totalWeight, second, decisions)]);
    scored.sort((a, b) => a[1] - b[1]);

    const refined = scored.slice(0, REFINE)
      .map(([i]) => [i, scoreSecond(S, W, totalWeight, i, new Map(), true)])
      .sort((a, b) => a[1] - b[1]);

    out.push({
      pattern, key: patternName(pattern), candidates: S.length,
      best: refined.slice(0, TOP_N).map(([i, t]) => [words.list[i], Math.round(t * 1000) / 1000]),
    });
  }
  return { opener: word, topN: TOP_N, states: out };
}

const requested = readFileSync(OPENER_FILE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const mine = requested.filter((_, i) => i % SHARDS === SHARD);
mkdirSync('data/book', { recursive: true });

console.log(`shard ${SHARD}/${SHARDS}: ${mine.length} openers, top ${TOP_N} seconds per state`);
const t0 = Date.now();
for (const [n, word] of mine.entries()) {
  const book = buildOpener(word);
  writeFileSync(`data/book/${word}.json`, JSON.stringify(book));
  const biggest = book.states[0];
  console.log(
    `  [${n + 1}/${mine.length}] ${word}  ${book.states.length} states  ` +
    `largest ${biggest.key} (${biggest.candidates}) -> ${biggest.best[0][0]} ${biggest.best[0][1]}  ` +
    `${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
}
