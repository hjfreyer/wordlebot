# wordlebot

Vendored Wordle word data: the full list of guesses the game accepts, plus a
word-frequency table for telling real words apart from dictionary padding.

Everything here is permissively licensed — attribution only, no copyleft.

## Data

| File | Rows | What it is |
| --- | --- | --- |
| `data/allowed_guesses.txt` | 14,855 | Every five-letter word Wordle accepts as a guess, lowercase, alphabetical, one per line. |
| `data/frequencies.csv` | 14,855 | `word,zipf` for each of those words. |

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

That answer list is not vendored here — it's only used as a yardstick for
choosing the threshold. Solving against it directly would be an easier game than
a real player faces, and NYT keeps curating it.

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
python3 scripts/fetch_lists.py        # refresh data/allowed_guesses.txt
python3 scripts/build_frequencies.py  # rebuild data/frequencies.csv
```

Stdlib only, no third-party dependencies. Both outputs are committed, so nothing
at runtime needs network access.

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

`data/frequencies.csv` is therefore CC BY 3.0 — attribution only, no
share-alike, commercial use fine. The rest of this repository is Apache-2.0.

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
