# wordlebot

Vendored Wordle word data: the full list of guesses the game accepts, plus a
word-frequency table for telling real words apart from dictionary padding.

Everything here is permissively licensed — attribution only, no copyleft.

## Data

| File | Rows | What it is |
| --- | --- | --- |
| `data/words.json` | 14,855 | **The browser bundle.** Words and frequencies packed into one file, 88 KB raw / 44 KB gzipped. |
| `data/allowed_guesses.txt` | 14,855 | Upstream snapshot: every five-letter word Wordle accepts, lowercase, alphabetical, one per line. |
| `data/frequencies.csv` | 14,855 | `word,zipf`. Human-readable intermediate — a packed blob is unreadable in a diff, so this is what you look at when the upstream list changes. |
| `data/answers.txt` | 2,309 | **Evaluation set, not shipped.** Words NYT has actually used, in puzzle order. Deliberately absent from `words.json` — see below. |

### Using the bundle

`words.json` is the file to ship. Every word is exactly five characters, so they
concatenate with no delimiters; frequencies are one character each in the same
order, quantized to 0.1 Zipf by flooring. Flooring rather than rounding means a
threshold on the bundle selects exactly the same words as the same threshold on
`frequencies.csv` — rounding would push a 1.49 word like *soare* over a 1.5
cutoff, which is precisely the word the filter exists to reject.

```js
const { words, freqs } = await (await fetch('words.json')).json();

const word = i => words.slice(i * 5, i * 5 + 5);
const zipf = i => (freqs.charCodeAt(i) - 48) / 10;

const valid = new Set(Array.from({ length: 14855 }, (_, i) => word(i)));
const candidates = Array.from({ length: 14855 }, (_, i) => i)
  .filter(i => zipf(i) >= 1.5)
  .map(word);
```

Note the two sets are different on purpose: `valid` is everything Wordle accepts
as a *guess*, `candidates` is the subset plausible as an *answer*.

The file carries a `_license` header. Keep it — see [Credits](#credits).

Zipf values are `log10(occurrences per billion words)`. Roughly: 6.0 is a word
like *about*, 4.0 is common, and 2.0 is uncommon. 0.0 means the word is absent
from the source corpus or rarer than one occurrence per billion — genuinely
rarer-than-that words are floored at 0.0 rather than carrying a negative.

```
audio 4.14    crane 4.07    slate 3.97
soare 1.49    wizzo 0.48    tares 0.00
```

### Picking a cutoff

6,467 of the 14,855 accepted guesses have a Zipf of 0.0 — Wordle accepts a much
larger dictionary than it ever draws answers from, and a large chunk of that
list is words almost nobody knows.

Checked against the 2,309 words NYT has actually used as answers:

| Threshold | Guesses kept | Real answers lost |
| --- | --- | --- |
| `>= 1.0` | 7,189 | 15 |
| `>= 1.5` | 6,098 | 15 |
| `>= 2.0` | 4,858 | 24 |
| `>= 2.5` | 3,537 | 211 |
| `>= 3.0` | 2,406 | 628 |

**`zipf >= 1.5` is a good "could plausibly be the answer" filter.** It cuts the
guess list by 59% while losing 15 real answers, and the cliff at 2.5 is where
you start doing real damage.

### The answer list, and why it's quarantined

`data/answers.txt` is vendored so that thresholds and models can be measured
rather than guessed at, but it is kept out of `data/words.json` on purpose. A
solver that can read the answer key isn't solving — it's looking up. Nothing in
the build pipeline copies it into the bundle, and `scripts/build_bundle.py`
reads only `frequencies.csv`.

It is stored in **puzzle order**, not alphabetically. That's what makes an
honest evaluation possible: split on time, fit on the earlier puzzles, and
measure against the later ones. Anything fitted against the whole list and then
scored on the whole list is reporting its own training accuracy.

Two properties of this list are worth knowing before you lean on it:

- **It's historical, not exhaustive.** These are answers NYT has used *so far*.
  A perfectly ordinary word that simply hasn't come up yet is labelled a
  non-answer, which puts a ceiling on how well any model can appear to score.
- **NYT keeps curating it.** Six words were dropped after the acquisition, and
  the list grows by one a day.

### Known weakness

The source corpus is Google **Books**, 1880–2020, filtered against dictionaries.
That makes it skew literary and lag on informal and modern vocabulary. All 15
answers it misses entirely are from that blind spot:

> awoke, axion, baler, bicep, bused, clued, cutie, cyber, eying, fritz, geeky,
> nerdy, rebar, saner, voila

If those matter for your use, they're a short enough list to floor by hand.
Across the 2,294 answers the corpus does cover, it correlates at r=0.912 with
[wordfreq](https://github.com/rspeer/wordfreq), which blends books with
subtitles, news, and web text — so the ranking is sound, the gaps are at the
edges.

## Regenerating

```sh
python3 scripts/fetch_lists.py        # refresh allowed_guesses.txt and answers.txt
python3 scripts/build_frequencies.py  # rebuild data/frequencies.csv
python3 scripts/build_bundle.py       # rebuild data/words.json
```

Run in that order — each step feeds the next. Stdlib only, no third-party
dependencies. All outputs are committed, so nothing at runtime needs network
access.

## Evaluating the solver

```sh
node scripts/eval.mjs [opener] [all|answers]
```

Plays the solver against every historical answer and reports guesses actually
taken, split into the puzzles the prior was fitted on and the ones held out.

Opening `crane`, over all 2,309 answers:

| strategy | mean guesses | solved within 6 | needed 7+ |
| --- | --- | --- | --- |
| all guesses (default) | **3.6643** | 99.35% | **0** |
| possible answers only | 3.7254 | 98.44% | 21 |

**Probes earn their place, but not by much on the mean.** Ranking every legal
guess beats restricting to possible answers by 0.06 guesses — while removing the
failure tail entirely. Candidates-only wins in 2 guesses three times as often
(91 games vs 30), because it always plays something that could win outright; it
pays by getting stranded among near-identical candidates and eliminating them
one at a time. Probes trade lucky early wins for never losing. The mean alone
hides this; the distribution is the point.

Both strategies bottom out at the same floor: the 15 answers outside the pool.

**On contamination.** The prior was fitted against these answers, so the split
matters. Held-out puzzles cost `+0.060` guesses (candidates-only) and `-0.007`
(all guesses) relative to those the fit saw — both negligible. Three
coefficients cannot memorise 2,309 words, so the headline figures are honest.

Prefer this to the search's own expected-cost numbers. Those are depth-limited
and use an optimistic leaf bound (`2 - 1/n`), so they rank moves correctly but
systematically understate cost — a deeper search can report a *higher* estimate
for the same position, because it has stopped guessing about the tail.

The eval also surfaces a hard failure the estimates cannot: **15 of the 2,309
answers fall below the prior's pool threshold and are unreachable at any depth**
(`cyber`, `geeky`, `nerdy`, `bicep`, `voila` and friends — the Google Books
blind spot described above). Pool coverage is 99.35%, and that ceiling applies
to every strategy equally.

## Credits

The word list comes from **[tabatkins/wordle-list](https://github.com/tabatkins/wordle-list)**,
extracted from the game's own source code. MIT licensed.

Frequencies are derived from the **Google Books Ngram** corpus, by way of
**[hackerb9/gwordlist](https://github.com/hackerb9/gwordlist)**, which provides a
dictionary-verified frequency list built from it. Google releases the Ngram data
under **[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)**; Google asks
that the Google Books Ngram Viewer be acknowledged as the source, which this
does. gwordlist's own scripts are GPLv3, but its data files are CC BY 3.0 and
that is all we consume here.

The frequency data is therefore CC BY 3.0 — attribution only, no share-alike,
commercial use fine. The rest of this repository is Apache-2.0.

**If you ship this in an SPA, the attribution requirement applies to you.**
Serving `words.json` to a browser is redistribution, and CC BY asks for credit
in a form reasonable to the medium. The bundle carries a `_license` header for
exactly this reason, but a header alone is thin if your build inlines the JSON
into a chunk. Put a line in your About or credits UI:

> Word frequencies derived from the Google Books Ngram Viewer, used under
> [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

This is cheap to satisfy and it's the entire cost of the data. It's also why the
frequencies aren't sourced from wordfreq — see below.

### Sources deliberately not used

- **[wordfreq](https://github.com/rspeer/wordfreq)** is the higher-quality
  dataset and is the right choice if copyleft is not a problem for you. Its data
  is CC-BY-SA-4.0, and its README explicitly asks people not to extract it into
  CSV form, on the grounds that a CSV has nowhere to carry attribution. Using it
  as a runtime dependency via its Python API is the author's endorsed path.
- **Norvig's `count_1w.txt`** and lists derived from it, such as
  google-10000-english, trace back to the Google Web Trillion Word Corpus
  distributed by the Linguistic Data Consortium. The MIT license covers Norvig's
  code, not the corpus; google-10000-english's own LICENSE.md advises against
  commercial use without an LDC license.
- **SUBTLEX** is excellent for spoken-word familiarity but is distributed for
  research use with conditions rather than under an open license.
