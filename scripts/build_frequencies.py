"""Generate data/frequencies.csv from Google Books Ngram frequencies.

Source data is hackerb9/gwordlist, a dictionary-verified frequency list derived
from the Google Books Ngram corpus (1880-2020). Google releases the Ngram data
under CC BY 3.0 -- attribution only, no share-alike -- which is why we use it
here rather than a more accurate but copyleft source. See README.md.

Requires no third-party packages. The generated CSV is committed.

Frequencies are Zipf values: log10(occurrences per billion words), so 6.0 is a
very common word and 1.0 is a rare one. Words absent from the corpus get 0.0.
"""

import csv
import math
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

FREQ_URL = (
    "https://raw.githubusercontent.com/hackerb9/gwordlist/master/"
    "frequency-alpha-alldicts.txt"
)


def load_counts():
    """Return {word: count} for five-letter words, plus the corpus total.

    The file is fixed-width-ish: RANKING WORD COUNT PERCENT CUMULATIVE, with
    thousands separators in COUNT. There's no total-words line, so we back it
    out of the first row's count and percent -- PERCENT itself is only good to
    six decimal places, which would floor every word below Zipf 1.0 if we used
    it directly.
    """
    with urllib.request.urlopen(FREQ_URL) as resp:
        lines = resp.read().decode("utf-8", "replace").splitlines()

    counts = {}
    total = None
    for line in lines:
        if line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 4:
            continue
        word = parts[1].lower()
        try:
            count = int(parts[2].replace(",", ""))
            percent = float(parts[3].rstrip("%"))
        except ValueError:
            continue
        if total is None and percent > 0:
            total = count / (percent / 100.0)
        if len(word) == 5 and word.isalpha():
            counts[word] = counts.get(word, 0) + count

    if total is None:
        raise ValueError("could not determine corpus size from frequency data")
    return counts, total


def main():
    counts, total = load_counts()
    words = (DATA / "allowed_guesses.txt").read_text().split()

    rows = []
    for word in words:
        count = counts.get(word, 0)
        # Words rarer than one per billion give a negative log. They're as good
        # as absent for our purposes, so floor them at 0.0 rather than carry
        # negatives in a column that exists to be thresholded.
        zipf = 0.0 if count == 0 else max(0.0, math.log10(count / total * 1e9))
        rows.append((word, round(zipf, 2)))

    out = DATA / "frequencies.csv"
    with out.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["word", "zipf"])
        writer.writerows(rows)

    unknown = sum(1 for _, z in rows if z == 0.0)
    print(f"{out.relative_to(ROOT)}: {len(rows)} words, {unknown} with zipf 0.0")
    for threshold in (1.0, 1.5, 2.0, 3.0):
        kept = sum(1 for _, z in rows if z >= threshold)
        print(f"  zipf >= {threshold}: {kept} words")


if __name__ == "__main__":
    main()
