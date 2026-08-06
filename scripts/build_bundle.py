"""Build data/words.json, the single-file bundle for the browser.

An SPA ships this data to every visitor, which makes it a redistribution, which
means the CC BY 3.0 attribution has to travel with it. That's the whole reason
this is JSON rather than a bare CSV -- the license header lives inside the file
and can't be separated from the data by a build step that only copies assets.

Words are all exactly five characters, so they're concatenated with no
delimiters. Frequencies are one character per word in the same order, quantized
to 0.1 Zipf.

Quantization floors rather than rounds. Rounding would promote a word at 1.49
over a 1.5 cutoff -- 'soare' among them, exactly the kind of word the filter
exists to reject -- and would make thresholds on the bundle disagree with the
same thresholds on frequencies.csv. Flooring keeps the stored value at or below
the true one, so `quantized >= t` selects precisely `true >= t` for any t on a
0.1 boundary.
"""

import csv
import json
import math
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

WORD_LEN = 5
FREQ_ORIGIN = 48  # '0', so the freq blob stays printable ASCII
FREQ_MAX = 66  # zipf 6.6, above the corpus maximum of 6.64

LICENSE = {
    "wordList": {
        "source": "https://github.com/tabatkins/wordle-list",
        "description": "Five-letter words Wordle accepts as guesses, from the game source.",
        "license": "MIT",
    },
    "frequencies": {
        "source": "Google Books Ngram Viewer (https://books.google.com/ngrams)",
        "via": "https://github.com/hackerb9/gwordlist",
        "description": "Zipf frequencies derived from the Google Books Ngram corpus.",
        "license": "CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/)",
    },
    "notice": (
        "Frequency data is CC BY 3.0 and requires attribution. If you strip this "
        "header, credit Google Books Ngram Viewer somewhere the user can see it."
    ),
}


def main():
    rows = [
        (r["word"], float(r["zipf"]))
        for r in csv.DictReader((DATA / "frequencies.csv").open())
    ]

    bad = [w for w, _ in rows if len(w) != WORD_LEN]
    if bad:
        raise ValueError(f"fixed-width packing needs 5-char words, got {bad[:5]}")

    words = "".join(w for w, _ in rows)
    # +1e-9 so a value stored as 3.15 doesn't floor to 3.1 through float error.
    freqs = "".join(
        chr(FREQ_ORIGIN + min(FREQ_MAX, math.floor(z * 10 + 1e-9))) for _, z in rows
    )

    bundle = {
        "_license": LICENSE,
        "count": len(rows),
        "encoding": (
            f"'words' is {len(rows)} concatenated {WORD_LEN}-char lowercase words. "
            f"'freqs' has one char per word in the same order; "
            f"zipf = (freqs.charCodeAt(i) - {FREQ_ORIGIN}) / 10."
        ),
        "words": words,
        "freqs": freqs,
    }

    out = DATA / "words.json"
    out.write_text(json.dumps(bundle, indent=2, ensure_ascii=True) + "\n")

    kb = out.stat().st_size / 1024
    print(f"{out.relative_to(ROOT)}: {len(rows)} words, {kb:.1f} KB")


if __name__ == "__main__":
    main()
