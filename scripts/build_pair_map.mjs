/**
 * Precompute, for a fixed opener and every possible second guess, the mean
 * turns to solve if you commit to both words blind.
 *
 *   node scripts/build_pair_map.mjs <openers.txt> [shard] [shards]
 *
 * Writes data/pairs/<opener>.u16 -- one uint16 per word in allowed_guesses.txt
 * order, holding round(meanTurns * 1000). Shards are disjoint slices of the
 * opener list, so N processes can run in parallel on N cores and each file is
 * complete on its own.
 *
 * What the number means, precisely:
 *
 *   Play `opener`, then play `second` regardless of what the opener revealed,
 *   then continue greedily. Averaged over the historical answers, excluding the
 *   ones outside the prior pool that no strategy can reach.
 *
 * Two caveats worth carrying:
 *
 *   - The continuation is greedy over surviving candidates, not an optimal
 *     search. Letting every word be considered at each later decision is more
 *     accurate but costs 8.4s per pair against 25ms -- 34 hours per opener
 *     rather than 6 minutes. Measured against full fidelity on matched words,
 *     this reads 0.008-0.034 turns high, consistently in the same direction, so
 *     it ranks well but is a slight overestimate in absolute terms.
 *   - It is an empirical mean over answers NYT has actually used, not a
 *     prior-weighted expectation over the pool.
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
const SHARD = Number(process.argv[3]) || 0;
const SHARDS = Number(process.argv[4]) || 1;
if (!OPENER_FILE) throw new Error('usage: build_pair_map.mjs <openers.txt> [shard] [shards]');

const words = decodeBundle(JSON.parse(readFileSync('data/words.json', 'utf8')));
const packed = packWords(words.list);
const answers = readFileSync('data/answers.txt', 'utf8').split('\n').filter(Boolean);

const all = [...Array(words.count).keys()];
const prior = new Float64Array(words.count);
for (let i = 0; i < words.count; i++) prior[i] = answerPrior(words.zipf[i], words.list[i]);
const pool = all.filter((i) => prior[i] >= POOL_MIN_PRIOR);
const targets = answers.map((w) => words.index.get(w)).filter((i) => i !== undefined);
const targetSet = new Set(targets);

const rank = (S, guesses) => {
  const r = createRanker(packed, guesses, S, Float64Array.from(S, (i) => prior[i]));
  r.step(Infinity);
  return r.result();
};

/**
 * Turns spent and answers stranded, playing greedily from candidate set S.
 * `live` are the answers still in play; `depth` is the turn about to be spent.
 */
function playOut(S, live, depth, decisions) {
  if (live.length === 0) return [0, 0];
  if (S.length === 0) return [0, live.length];

  const key = S.join(',');
  let guess = decisions.get(key);
  if (guess === undefined) {
    guess = rank(S, S)[0].index;
    decisions.set(key, guess);
  }

  let turns = 0;
  let stranded = 0;
  const byPattern = new Map();
  for (const a of live) {
    if (a === guess) { turns += depth; continue; }
    const p = patternOf(packed, guess, a);
    if (!byPattern.has(p)) byPattern.set(p, []);
    byPattern.get(p).push(a);
  }
  if (byPattern.size === 0) return [turns, stranded];

  const splitS = new Map();
  for (const c of S) {
    const p = patternOf(packed, guess, c);
    if (!splitS.has(p)) splitS.set(p, []);
    splitS.get(p).push(c);
  }
  for (const [p, group] of byPattern) {
    const [t, u] = playOut(splitS.get(p) ?? [], group, depth + 1, decisions);
    turns += t; stranded += u;
  }
  return [turns, stranded];
}

function buildRow(opener) {
  // Opener feedback is fixed across every second guess, so compute it once.
  const openerPattern = new Int16Array(words.count);
  for (const c of pool) openerPattern[c] = patternOf(packed, opener, c);
  const openerAnswerPattern = new Map();
  for (const a of targets) openerAnswerPattern.set(a, patternOf(packed, opener, a));

  const row = new Uint16Array(words.count);
  const decisions = new Map();

  for (const second of all) {
    const groups = new Map();
    for (const a of targets) {
      if (a === opener || a === second) continue;
      const key = openerAnswerPattern.get(a) * 243 + patternOf(packed, second, a);
      if (!groups.has(key)) groups.set(key, { live: [], S: [] });
      groups.get(key).live.push(a);
    }
    for (const c of pool) {
      const key = openerPattern[c] * 243 + patternOf(packed, second, c);
      const g = groups.get(key);
      if (g) g.S.push(c);
    }

    let turns = 0, solved = 0;
    if (targetSet.has(opener)) { turns += 1; solved += 1; }
    if (targetSet.has(second) && second !== opener) { turns += 2; solved += 1; }
    for (const { live, S } of groups.values()) {
      const [t, stranded] = playOut(S, live, 3, decisions);
      turns += t; solved += live.length - stranded;
    }

    // 65535 / 1000 caps at 65 turns; real values sit near 4.
    row[second] = Math.min(65535, Math.round((turns / solved) * 1000));
  }
  return row;
}

const requested = readFileSync(OPENER_FILE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const mine = requested.filter((_, i) => i % SHARDS === SHARD);
mkdirSync('data/pairs', { recursive: true });

console.log(`shard ${SHARD}/${SHARDS}: ${mine.length} openers of ${requested.length}`);
const t0 = Date.now();
for (const [n, word] of mine.entries()) {
  const opener = words.index.get(word);
  if (opener === undefined) throw new Error(`opener "${word}" is not in the word list`);
  const row = buildRow(opener);
  writeFileSync(`data/pairs/${word}.u16`, Buffer.from(row.buffer));
  const best = all.reduce((a, b) => (row[b] < row[a] ? b : a));
  console.log(
    `  [${n + 1}/${mine.length}] ${word}  best second: ${words.list[best]} ` +
    `(${(row[best] / 1000).toFixed(3)} turns)  ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
}
