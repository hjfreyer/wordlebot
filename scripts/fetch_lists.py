"""Re-download the vendored word list from its upstream source.

The output of this script is committed under data/, so you only need to run it
to refresh the list after NYT changes the dictionary. See README.md for
provenance and licensing.
"""

import pathlib
import urllib.request

DATA = pathlib.Path(__file__).resolve().parent.parent / "data"

GUESSES_URL = "https://raw.githubusercontent.com/tabatkins/wordle-list/main/words"


def main():
    DATA.mkdir(exist_ok=True)

    with urllib.request.urlopen(GUESSES_URL) as resp:
        body = resp.read().decode("utf-8")
    words = sorted(w.strip().lower() for w in body.split() if w.strip())

    bad = [w for w in words if len(w) != 5 or not w.isalpha() or not w.islower()]
    if bad:
        raise ValueError(f"{len(bad)} malformed entries, e.g. {bad[:5]}")
    if len(set(words)) != len(words):
        raise ValueError("list contains duplicates")

    path = DATA / "allowed_guesses.txt"
    path.write_text("\n".join(words) + "\n")
    print(f"{path.relative_to(DATA.parent)}: {len(words)} words")


if __name__ == "__main__":
    main()
