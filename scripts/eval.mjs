/**
 * Play the solver against every historical Wordle answer and report how many
 * guesses it actually needs.
 *
 * The estimated-cost numbers the search reports are depth-limited and use an
 * optimistic leaf bound, so they rank moves well but are not calibrated
 * predictions. This measures the thing that matters instead: real guesses taken
 * against real answers.
 *
 * The prior's coefficients were fitted against this same answer list, so the
 * headline number is optimistic. Results are reported split on puzzle order --
 * the earlier puzzles the fit saw, and the later ones held out -- and it is the
 * held-out figure that means anything.
 *
 *   node scripts/eval.mjs [opener] [strategy] [limit]
 *     opener    first guess, default "crane"
 *     strategy  "all" (rank every legal guess) or "answers" (candidates only)
 *     limit     play only the first N answers, for a quick check
 */

import { readFileSync } from 'node:fs';
import { decodeBundle } from '../src/wordle.js';
import {
  POOL_MIN_PRIOR,
  answerPrior,
  createRanker,
  patternOf,
  packWords,
} from '../src/solver.js';

const OPENER = process.argv[2] ?? 'crane';
const STRATEGY = process.argv[3] ?? 'all';
const MAX_GUESSES = 12;
const TRAIN_FRACTION = 0.7;
const LIMIT = Number(process.argv[4]) || Infinity;

const words = decodeBundle(JSON.parse(readFileSync('data/words.json', 'utf8')));
const packed = packWords(words.list);
const answers = readFileSync('data/answers.txt', 'utf8')
  .split('\n')
  .filter(Boolean)
  .slice(0, LIMIT);

const prior = new Float64Array(words.count);
for (let i = 0; i < words.count; i++) prior[i] = answerPrior(words.zipf[i], words.list[i]);

const all = [...Array(words.count).keys()];
const pool = all.filter((i) => prior[i] >= POOL_MIN_PRIOR);
const opener = words.index.get(OPENER);
if (opener === undefined) throw new Error(`opener "${OPENER}" is not in the word list`);

// Everything below works in word indices, never strings -- comparing the two
// silently never matches, which reads as "unreachable" for every game.
const targets = answers.map((w) => {
  const i = words.index.get(w);
  if (i === undefined) throw new Error(`answer "${w}" is missing from the word list`);
  return i;
});

/** Guesses needed to reach `target` (a word index), or null if unreachable. */
function play(target) {
  let candidates = pool;
  let guess = opener;

  for (let n = 1; n <= MAX_GUESSES; n++) {
    if (guess === target) return n;

    const pattern = patternOf(packed, guess, target);
    candidates = candidates.filter((c) => patternOf(packed, guess, c) === pattern);
    // The target fell outside the prior pool; no sequence of guesses reaches it.
    if (candidates.length === 0) return null;

    const weights = Float64Array.from(candidates, (i) => prior[i]);
    const ranker = createRanker(
      packed,
      STRATEGY === 'answers' ? candidates : all,
      candidates,
      weights,
    );
    ranker.step(Infinity);
    guess = ranker.result()[0].index;
  }
  return null;
}

function summarise(label, results) {
  const solved = results.filter((r) => r !== null);
  const mean = solved.reduce((a, b) => a + b, 0) / solved.length;
  const hist = new Map();
  for (const r of solved) hist.set(r, (hist.get(r) ?? 0) + 1);
  const within6 = solved.filter((r) => r <= 6).length;

  console.log(`\n${label}  (n=${results.length})`);
  console.log(`  mean guesses      ${mean.toFixed(4)}`);
  console.log(`  solved within 6   ${within6}/${results.length} (${(100 * within6 / results.length).toFixed(2)}%)`);
  console.log(`  unreachable       ${results.length - solved.length}`);
  const dist = [...hist.entries()].sort((a, b) => a[0] - b[0])
    .map(([k, v]) => `${k}:${v}`).join('  ');
  console.log(`  distribution      ${dist}`);
  return mean;
}

const cut = Math.floor(answers.length * TRAIN_FRACTION);
console.log(`opener "${OPENER}", strategy "${STRATEGY}", ${answers.length} historical answers`);
console.log(`prior fitted on puzzles 1-${cut}; puzzles ${cut + 1}-${answers.length} are held out`);

const t0 = Date.now();
const results = targets.map(play);
console.log(`\nplayed ${answers.length} games in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

summarise('ALL answers (optimistic -- prior saw these)', results);
const seen = summarise('SEEN by the fit (puzzles 1-' + cut + ')', results.slice(0, cut));
const held = summarise('HELD OUT (puzzles ' + (cut + 1) + '+)', results.slice(cut));
console.log(`\nheld-out minus seen: ${(held - seen).toFixed(4)} guesses`);
console.log('(a large positive gap would mean the prior is memorising rather than generalising)');
