export const WORD_LEN = 5;

// Must match FREQ_ORIGIN in scripts/build_bundle.py.
const FREQ_ORIGIN = 48;

/** Expand the packed bundle into a word array and a parallel Zipf array. */
export function decodeBundle(bundle) {
  const { words, freqs, count } = bundle;
  if (words.length !== count * WORD_LEN || freqs.length !== count) {
    throw new Error('words.json is malformed: blob lengths disagree with count');
  }

  const list = new Array(count);
  const zipf = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    list[i] = words.slice(i * WORD_LEN, i * WORD_LEN + WORD_LEN);
    zipf[i] = (freqs.charCodeAt(i) - FREQ_ORIGIN) / 10;
  }

  return { list, zipf, index: new Map(list.map((w, i) => [w, i])), count };
}

export async function loadWords(url = 'words.json') {
  // The single-file build (scripts/build_single.mjs) has no second file to
  // fetch, so it injects the bundle here instead.
  if (globalThis.__WORDS_BUNDLE__) return decodeBundle(globalThis.__WORDS_BUNDLE__);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${url} (HTTP ${res.status})`);
  return decodeBundle(await res.json());
}

/**
 * Score a guess against a target, Wordle-style.
 *
 * Two passes, because repeated letters are the whole difficulty here: greens
 * are claimed first, then yellows draw from whatever letters are left over. A
 * single pass would mark the first L of "lolly" yellow against "hello" even
 * though "hello"'s only unmatched L was already spoken for.
 */
export function scoreGuess(guess, target) {
  const result = new Array(WORD_LEN).fill('absent');
  const unmatched = new Map();

  for (let i = 0; i < WORD_LEN; i++) {
    if (guess[i] === target[i]) {
      result[i] = 'correct';
    } else {
      unmatched.set(target[i], (unmatched.get(target[i]) ?? 0) + 1);
    }
  }

  for (let i = 0; i < WORD_LEN; i++) {
    if (result[i] === 'correct') continue;
    const left = unmatched.get(guess[i]) ?? 0;
    if (left > 0) {
      result[i] = 'present';
      unmatched.set(guess[i], left - 1);
    }
  }

  return result;
}

const RANK = { absent: 0, present: 1, correct: 2 };

/** Best-known state per letter, for colouring the on-screen keyboard. */
export function keyboardStates(scoredRows) {
  const states = new Map();
  for (const { word, score } of scoredRows) {
    for (let i = 0; i < WORD_LEN; i++) {
      const prev = states.get(word[i]);
      if (prev === undefined || RANK[score[i]] > RANK[prev]) {
        states.set(word[i], score[i]);
      }
    }
  }
  return states;
}

/**
 * Split the raw letter buffer into a target and guess rows.
 *
 * The whole game state is one string: the first five letters are the target,
 * every five after that are a guess. That's what makes backspacing across row
 * boundaries fall out for free -- there are no committed rows to undo.
 */
export function parseBuffer(text) {
  const target = text.slice(0, WORD_LEN);
  const rest = text.slice(WORD_LEN);

  const guesses = [];
  for (let i = 0; i < rest.length; i += WORD_LEN) {
    guesses.push(rest.slice(i, i + WORD_LEN));
  }
  // Always leave a row to type into.
  if (guesses.length === 0 || guesses.at(-1).length === WORD_LEN) guesses.push('');

  return {
    target,
    guesses,
    targetReady: target.length === WORD_LEN,
    cursorRow: text.length < WORD_LEN ? 0 : Math.floor(text.length / WORD_LEN),
    cursorCol: text.length % WORD_LEN,
  };
}
