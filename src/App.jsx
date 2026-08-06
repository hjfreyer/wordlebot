import { useCallback, useEffect, useMemo, useState } from 'react';
import SolverPanel from './SolverPanel.jsx';
import { randomTarget } from './solver.js';
import {
  WORD_LEN,
  keyboardStates,
  loadWords,
  parseBuffer,
  scoreGuess,
} from './wordle.js';

const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const ENCODE = { absent: 0, present: 1, correct: 2 };

export default function App() {
  const [words, setWords] = useState(null);
  const [error, setError] = useState(null);
  const [text, setText] = useState('');
  const [hideTarget, setHideTarget] = useState(false);

  useEffect(() => {
    loadWords().then(setWords, (e) => setError(e.message));
  }, []);

  const type = useCallback((letter) => setText((t) => t + letter), []);
  const backspace = useCallback(() => setText((t) => t.slice(0, -1)), []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Backspace') {
        e.preventDefault();
        backspace();
      } else if (/^[a-zA-Z]$/.test(e.key)) {
        e.preventDefault();
        type(e.key.toLowerCase());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [type, backspace]);

  const game = useMemo(() => {
    const { target, guesses, targetReady, cursorRow, cursorCol } = parseBuffer(text);

    const rows = guesses.map((word, i) => ({
      word,
      complete: word.length === WORD_LEN,
      // Only score once there's a target to score against.
      score: targetReady && word.length === WORD_LEN ? scoreGuess(word, target) : null,
      known: words ? words.index.has(word) : true,
      rowIndex: i + 1,
    }));

    const scored = rows.filter((r) => r.score);

    // What a solver would know: each completed guess and the feedback it drew.
    const observations = scored.map((r) => ({
      word: r.word,
      pattern: r.score.reduce((acc, s, i) => acc + ENCODE[s] * 3 ** i, 0),
    }));

    return {
      target,
      targetReady,
      rows,
      cursorRow,
      cursorCol,
      observations,
      skippedObservations: scored.filter((r) => !r.known).length,
      keys: keyboardStates(scored),
      solvedAt: scored.findIndex((r) => r.word === target) + 1 || null,
      targetKnown: words && targetReady ? words.index.has(target) : true,
      targetZipf:
        words && targetReady && words.index.has(target)
          ? words.zipf[words.index.get(target)]
          : null,
    };
  }, [text, words]);

  if (error) return <div className="layout"><main className="app"><p className="error">{error}</p></main></div>;
  if (!words)
    return <div className="layout"><main className="app"><p className="muted">Loading words…</p></main></div>;

  return (
    <div className="layout">
      <main className="app">
        <header>
        <h1>wordlebot</h1>
        <p className="muted">
          Type five letters to set the target, then keep typing to guess.
          Backspace runs back through everything.
        </p>
      </header>

      <div className="controls">
        <button
          onClick={() => {
            setText(randomTarget(words));
            setHideTarget(true);
          }}
        >
          Random target
        </button>
        <button onClick={() => setHideTarget((h) => !h)} disabled={!game.targetReady}>
          {hideTarget ? 'Reveal' : 'Hide'} target
        </button>
        <button onClick={() => setText(text.slice(0, WORD_LEN))} disabled={!text.slice(WORD_LEN)}>
          Clear guesses
        </button>
        <button onClick={() => { setText(''); setHideTarget(false); }} disabled={!text}>
          Reset
        </button>
      </div>

      <section className="board" aria-label="Game board">
        <Row
          letters={game.target}
          masked={hideTarget}
          variant="target"
          active={game.cursorRow === 0 ? game.cursorCol : -1}
          label="Target"
        />
        <hr />
        {game.rows.map((row) => (
          <Row
            key={row.rowIndex}
            letters={row.word}
            score={row.score}
            variant={!row.complete || row.known ? 'guess' : 'guess unknown'}
            active={game.cursorRow === row.rowIndex ? game.cursorCol : -1}
            label={`Guess ${row.rowIndex}`}
          />
        ))}
      </section>

      <p className="status" role="status">
        {!game.targetReady
          ? `Type ${WORD_LEN - game.target.length} more letter${
              WORD_LEN - game.target.length === 1 ? '' : 's'
            } to set the target.`
          : game.solvedAt
            ? `Solved in ${game.solvedAt} guess${game.solvedAt === 1 ? '' : 'es'}.`
            : !game.targetKnown
              ? `“${game.target}” isn’t in the word list — playable, but not a real target.`
              : `Target set${
                  game.targetZipf !== null ? ` (Zipf ${game.targetZipf.toFixed(1)})` : ''
                }. Keep typing to guess.`}
      </p>

      <Keyboard states={game.keys} onKey={type} onBackspace={backspace} />
      </main>

      <SolverPanel
        words={words}
        observations={game.observations}
        skipped={game.skippedObservations}
      />

      <footer className="muted">
        Word list from{' '}
        <a href="https://github.com/tabatkins/wordle-list">tabatkins/wordle-list</a> (MIT).
        Frequencies derived from the{' '}
        <a href="https://books.google.com/ngrams">Google Books Ngram Viewer</a>, used under{' '}
        <a href="https://creativecommons.org/licenses/by/3.0/">CC BY 3.0</a>.
      </footer>
    </div>
  );
}

function Row({ letters, score, variant, active, masked, label }) {
  const cells = [];
  for (let i = 0; i < WORD_LEN; i++) {
    const letter = letters[i] ?? '';
    const state = score ? score[i] : '';
    cells.push(
      <div
        key={i}
        className={`cell ${state} ${i === active ? 'active' : ''} ${letter ? 'filled' : ''}`}
      >
        {masked && letter ? '•' : letter}
      </div>,
    );
  }
  return (
    <div className={`row ${variant}`} aria-label={label}>
      {cells}
    </div>
  );
}

function Keyboard({ states, onKey, onBackspace }) {
  return (
    <div className="keyboard">
      {KEY_ROWS.map((row, i) => (
        <div className="krow" key={row}>
          {i === 2 && <button className="key wide" onClick={onBackspace}>⌫</button>}
          {[...row].map((k) => (
            <button
              key={k}
              className={`key ${states.get(k) ?? ''}`}
              onClick={() => onKey(k)}
            >
              {k}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
