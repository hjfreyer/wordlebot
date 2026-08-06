import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRanker, filterCandidates, packWords } from './solver.js';

// Rows rendered at once. The candidate list opens at ~6,000 words and nobody
// scrolls that far, so the tail is summarised rather than mounted.
const SHOWN = 200;
// Guesses ranked per animation frame. Each costs |S| pattern computations, so
// this is a tradeoff between total time and frame budget.
const CHUNK = 48;

export default function SolverPanel({ words, minZipf, observations, skipped }) {
  const packed = useMemo(() => packWords(words.list), [words]);

  const pool = useMemo(() => {
    const out = [];
    for (let i = 0; i < words.count; i++) if (words.zipf[i] >= minZipf) out.push(i);
    return out;
  }, [words, minZipf]);

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

  const [ranked, setRanked] = useState(null);
  const [progress, setProgress] = useState(0);
  const frame = useRef(0);

  // Layout, not passive: `candidates` updates during render while `ranked`
  // updates in an effect, so a passive effect would let the browser paint the
  // new count beside the previous word list.
  useLayoutEffect(() => {
    setRanked(null);
    setProgress(0);
    const ranker = createRanker(packed, candidates, candidates);

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
  }, [packed, candidates]);

  // Entropy of the remaining set: how many bits are still unknown.
  const remaining = candidates.length > 0 ? Math.log2(candidates.length) : 0;

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
          Nothing matches. The target may be outside the Zipf {minZipf} pool.
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
              <span title="Expected information gained by guessing this word">bits</span>
            </li>
            {ranked.slice(0, SHOWN).map((r) => (
              <li key={r.index}>
                <span className="w">{words.list[r.index]}</span>
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
