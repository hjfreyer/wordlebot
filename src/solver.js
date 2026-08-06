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
 * Expected information, in bits, for each candidate played as the next guess.
 *
 * A guess partitions the remaining candidates by the feedback it would produce.
 * The bits it yields is the entropy of that partition: -sum p*log2(p). A guess
 * that splits the field evenly scores high; one that usually returns the same
 * pattern scores low.
 */
export function createRanker(packed, guesses, candidates) {
  const counts = new Int32Array(PATTERN_COUNT);
  const touched = new Int32Array(PATTERN_COUNT);
  const total = candidates.length;
  const ranked = new Array(guesses.length);
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
          if (counts[p] === 0) touched[seen++] = p;
          counts[p]++;
        }

        let bits = 0;
        for (let k = 0; k < seen; k++) {
          const p = counts[touched[k]] / total;
          bits -= p * Math.log2(p);
          counts[touched[k]] = 0;
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

/**
 * Rank every guess in one go.
 *
 * Ranking the full 6,098-word pool against itself is ~37M pattern computations
 * and takes seconds, so the UI drives createRanker() in slices instead. This
 * wrapper is for tests and offline analysis, where blocking is fine.
 */
export function rankByInformation(packed, guesses, candidates) {
  const ranker = createRanker(packed, guesses, candidates);
  ranker.step(Infinity);
  return ranker.result();
}
