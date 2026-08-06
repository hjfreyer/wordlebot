import { WORD_LEN } from './wordle.js';

export const PATTERN_COUNT = 3 ** WORD_LEN; // 243

/**
 * Pack a word list into one flat Uint8Array of letter indices.
 *
 * The solver's inner loop runs tens of millions of times, so words live as
 * bytes in a single buffer rather than as JS strings.
 */
export function packWords(list) {
  const packed = new Uint8Array(list.length * WORD_LEN);
  for (let i = 0; i < list.length; i++) {
    for (let j = 0; j < WORD_LEN; j++) {
      packed[i * WORD_LEN + j] = list[i].charCodeAt(j) - 97;
    }
  }
  return packed;
}

/**
 * Score guess against target, both given as offsets into `packed`, returning
 * the feedback as a base-3 integer in [0, 243).
 *
 * Same two-pass rule as scoreGuess(), but it tracks consumed target positions
 * in a 5-bit mask instead of a letter-count map. A map would mean allocating or
 * clearing per call, and this is called ~37M times for a full ranking.
 */
const digits = new Uint8Array(WORD_LEN); // scratch, reused across calls

export function patternOf(packed, guess, target) {
  const g = guess * WORD_LEN;
  const t = target * WORD_LEN;
  let used = 0;

  // Greens claim their target position first.
  for (let i = 0; i < WORD_LEN; i++) {
    if (packed[g + i] === packed[t + i]) {
      digits[i] = 2;
      used |= 1 << i;
    } else {
      digits[i] = 0;
    }
  }

  // Yellows must be assigned LEFT TO RIGHT: with two of a letter in the guess
  // and one in the target, the leftmost unmatched position gets it. Packing the
  // base-3 number in the same loop would force right-to-left and silently mark
  // the wrong copy -- 'queen' against 'virge' puts the yellow on the second e.
  for (let i = 0; i < WORD_LEN; i++) {
    if (digits[i] === 2) continue;
    const c = packed[g + i];
    for (let j = 0; j < WORD_LEN; j++) {
      if ((used >> j) & 1) continue;
      if (packed[t + j] === c) {
        used |= 1 << j;
        digits[i] = 1;
        break;
      }
    }
  }

  let p = 0;
  for (let i = WORD_LEN - 1; i >= 0; i--) p = p * 3 + digits[i];
  return p;
}

/** Indices of pool words consistent with every observed guess/pattern pair. */
export function filterCandidates(packed, pool, observations) {
  if (observations.length === 0) return pool;
  return pool.filter((cand) =>
    observations.every(({ guess, pattern }) => patternOf(packed, guess, cand) === pattern),
  );
}

/**
 * Prior probability that a word is the answer.
 *
 * Logistic regression on two features, fitted against the words NYT has
 * actually used as answers:
 *
 *   P = sigmoid(2.192*zipf - 8.715*pluralish - 6.665)
 *
 * Frequency alone is not enough. It scores log-loss 0.201 and reproduces only
 * 7 of the true top 20 openers, because the guess list is 29% -s words while
 * real answers are 1.6% -s. Among common words, 10.7% of -s endings are
 * answers versus 77.4% of everything else. Adding that feature takes log-loss
 * to 0.171 and the overlap to 16/20.
 *
 * Only these three coefficients came from the answer list. The list itself is
 * not shipped and the solver never consults it.
 *
 * The fit overshoots above Zipf 5, where the empirical rate plateaus near 0.8
 * rather than approaching 1: the answer list is finite and historical, so a
 * common word NYT simply hasn't used yet is labelled a non-answer.
 */
export const PRIOR_ZIPF = 2.192;
export const PRIOR_PLURAL = -8.715;
export const PRIOR_INTERCEPT = -6.665;

/** Words below this prior hold 1.4% of the total mass between them. */
export const POOL_MIN_PRIOR = 0.01;

/**
 * Does the trailing -s look like an inflection rather than part of the stem?
 * `floss`, `focus`, `chaos`, `oasis` keep their s; `tares` and `rates` don't.
 */
export function pluralish(word) {
  return word.endsWith('s') && !'suio'.includes(word[WORD_LEN - 2]);
}

export function answerPrior(zipf, word) {
  const z = PRIOR_ZIPF * zipf + PRIOR_PLURAL * (pluralish(word) ? 1 : 0) + PRIOR_INTERCEPT;
  return 1 / (1 + Math.exp(-z));
}

/**
 * Expected information for each guess, over a weighted answer distribution.
 *
 * `weights[i]` is the prior for `candidates[i]`. Instead of every remaining
 * word being equally likely, each pattern's probability is the share of prior
 * mass that lands in it -- so splitting off a bucket of implausible words
 * counts for much less than splitting off a bucket of likely ones.
 */
export function createRanker(packed, guesses, candidates, weights) {
  const buckets = new Float64Array(PATTERN_COUNT);
  const touched = new Int32Array(PATTERN_COUNT);
  const total = candidates.length;
  const ranked = new Array(guesses.length);

  let totalWeight = 0;
  for (let i = 0; i < total; i++) totalWeight += weights[i];

  let next = 0;

  return {
    total: guesses.length,
    get done() {
      return next >= guesses.length;
    },
    get progress() {
      return guesses.length === 0 ? 1 : next / guesses.length;
    },

    /** Rank up to `n` more guesses. Returns true once every guess is ranked. */
    step(n) {
      const stop = Math.min(next + n, guesses.length);
      for (; next < stop; next++) {
        const guess = guesses[next];
        let seen = 0;

        for (let ci = 0; ci < total; ci++) {
          const p = patternOf(packed, guess, candidates[ci]);
          if (buckets[p] === 0) touched[seen++] = p;
          buckets[p] += weights[ci];
        }

        let bits = 0;
        for (let k = 0; k < seen; k++) {
          const p = buckets[touched[k]] / totalWeight;
          // A bucket can hold only near-zero-prior words; skip rather than
          // let log2 of a denormal poison the sum.
          if (p > 0) bits -= p * Math.log2(p);
          buckets[touched[k]] = 0;
        }

        ranked[next] = { index: guess, bits, buckets: seen };
      }
      return this.done;
    },

    result() {
      return ranked.slice(0, next).sort((a, b) => b.bits - a.bits);
    },
  };
}

/** Shannon entropy of the answer distribution itself: the bits still unknown. */
export function remainingBits(weights) {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  if (total === 0) return 0;

  let bits = 0;
  for (let i = 0; i < weights.length; i++) {
    const p = weights[i] / total;
    if (p > 0) bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Rank every guess in one go.
 *
 * Ranking the full 6,098-word pool against itself is ~37M pattern computations
 * and takes seconds, so the UI drives createRanker() in slices instead. This
 * wrapper is for tests and offline analysis, where blocking is fine.
 */
export function rankByInformation(packed, guesses, candidates, weights) {
  const ranker = createRanker(
    packed,
    guesses,
    candidates,
    weights ?? new Float64Array(candidates.length).fill(1),
  );
  ranker.step(Infinity);
  return ranker.result();
}

/**
 * Draw a target from the prior, sampling proportional to P(answer).
 *
 * Must use the same distribution the solver pools on: picking by raw frequency
 * could land on a plural like "tares", whose prior is ~1e-5, leaving the solver
 * with an empty candidate set and no way to reach the answer.
 */
export function randomTarget(words, rand = Math.random) {
  let total = 0;
  const weights = new Float64Array(words.count);
  for (let i = 0; i < words.count; i++) {
    const p = answerPrior(words.zipf[i], words.list[i]);
    weights[i] = p >= POOL_MIN_PRIOR ? p : 0;
    total += weights[i];
  }

  let r = rand() * total;
  for (let i = 0; i < words.count; i++) {
    r -= weights[i];
    if (r <= 0) return words.list[i];
  }
  return words.list[words.count - 1]; // float drift on the last bucket
}
