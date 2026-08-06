import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  POOL_MIN_PRIOR,
  answerPrior,
  createRanker,
  filterCandidates,
  packWords,
  remainingBits,
} from './solver.js';

// Rows rendered at once. The candidate list opens at ~6,000 words and nobody
// scrolls that far, so the tail is summarised rather than mounted.
const SHOWN = 200;
// Guesses ranked per animation frame. Each costs |S| pattern computations, so
// this is a tradeoff between total time and frame budget.
const CHUNK = 48;

export default function SolverPanel({ words, observations, skipped }) {
  const packed = useMemo(() => packWords(words.list), [words]);

  // Prior probability each word is the answer. Replaces the old hard Zipf
  // cutoff: the pool is now "words with a non-negligible prior", and within it
  // words are weighted rather than treated as equally likely.
  const prior = useMemo(() => {
    const p = new Float64Array(words.count);
    for (let i = 0; i < words.count; i++) p[i] = answerPrior(words.zipf[i], words.list[i]);
    return p;
  }, [words]);

  const pool = useMemo(() => {
    const out = [];
    for (let i = 0; i < words.count; i++) if (prior[i] >= POOL_MIN_PRIOR) out.push(i);
    return out;
  }, [words, prior]);

  // Keyed on content, not array identity: `observations` is rebuilt on every
  // keystroke, but typing into an unfinished row doesn't change what's known.
  // Depending on identity would restart the whole ranking on each letter.
  const obsKey = observations.map((o) => `${o.word}:${o.pattern}`).join('|');
  const obs = useMemo(
    () =>
      observations
        .map(({ word, pattern }) => ({ guess: words.index.get(word), pattern }))
        .filter((o) => o.guess !== undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [obsKey, words],
  );

  const candidates = useMemo(
    () => filterCandidates(packed, pool, obs),
    [packed, pool, obs],
  );

  // Renormalised over the surviving candidates: P(this word is the answer,
  // given everything known so far).
  const weights = useMemo(
    () => Float64Array.from(candidates, (i) => prior[i]),
    [candidates, prior],
  );
  const totalWeight = useMemo(() => weights.reduce((a, b) => a + b, 0), [weights]);

  // Keyed by word index, so a guess that isn't a candidate resolves to 0 --
  // that's what marks a pure probe once non-answers are ranked too.
  const chanceOf = useMemo(() => {
    const byIndex = new Map();
    for (let i = 0; i < candidates.length; i++) byIndex.set(candidates[i], weights[i]);
    return (index) => (totalWeight > 0 ? (byIndex.get(index) ?? 0) / totalWeight : 0);
  }, [candidates, weights, totalWeight]);

  const [ranked, setRanked] = useState(null);
  const [progress, setProgress] = useState(0);
  const frame = useRef(0);

  // Layout, not passive: `candidates` updates during render while `ranked`
  // updates in an effect, so a passive effect would let the browser paint the
  // new count beside the previous word list.
  useLayoutEffect(() => {
    setRanked(null);
    setProgress(0);
    const ranker = createRanker(packed, candidates, candidates, weights);

    const pump = () => {
      if (ranker.step(CHUNK)) {
        setRanked(ranker.result());
      } else {
        setProgress(ranker.progress);
        frame.current = requestAnimationFrame(pump);
      }
    };
    pump();

    return () => cancelAnimationFrame(frame.current);
  }, [packed, candidates, weights]);

  // Bits still unknown. Weighted, so a field padded with implausible words
  // reads as less uncertain than log2(count) would suggest.
  const remaining = useMemo(() => remainingBits(weights), [weights]);

  return (
    <aside className="solver" aria-label="Solver">
      <h2>Possible words</h2>

      <p className="solver-summary">
        <strong>{candidates.length.toLocaleString()}</strong>{' '}
        {candidates.length === 1 ? 'word matches' : 'words match'} what you know
        {candidates.length > 0 && <> · {remaining.toFixed(1)} bits left</>}
      </p>

      {skipped > 0 && (
        <p className="solver-note">
          {skipped} guess{skipped === 1 ? '' : 'es'} not in the word list
          {skipped === 1 ? ' was' : ' were'} ignored.
        </p>
      )}

      {candidates.length === 0 ? (
        <p className="solver-note">
          Nothing matches. The target may be too obscure to be in the answer pool.
        </p>
      ) : ranked === null ? (
        <div className="solver-progress" role="status">
          <div className="bar" style={{ width: `${Math.round(progress * 100)}%` }} />
          <span>Ranking {candidates.length.toLocaleString()} words…</span>
        </div>
      ) : (
        <>
          <ol className="solver-list">
            <li className="solver-head">
              <span>word</span>
              <span title="Probability this word is the answer. 0% means it can only ever be a probe.">
                p(answer)
              </span>
              <span title="Expected information gained by guessing this word">bits</span>
            </li>
            {ranked.slice(0, SHOWN).map((r) => (
              <li key={r.index}>
                <span className="w">{words.list[r.index]}</span>
                <span className={`p ${chanceOf(r.index) === 0 ? 'probe' : ''}`}>
                  {formatChance(chanceOf(r.index))}
                </span>
                <span className="b">{r.bits.toFixed(2)}</span>
              </li>
            ))}
          </ol>
          {ranked.length > SHOWN && (
            <p className="solver-note">
              Showing the top {SHOWN} of {ranked.length.toLocaleString()}.
            </p>
          )}
        </>
      )}
    </aside>
  );
}

/** A dash, not 0%, for words that can never be the answer -- pure probes. */
function formatChance(p) {
  if (p === 0) return '—';
  if (p < 0.001) return '<0.1%';
  return `${(p * 100).toFixed(1)}%`;
}
