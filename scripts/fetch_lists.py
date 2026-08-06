"""Re-download the vendored word lists from their upstream sources.

The output of this script is committed under data/, so you only need to run it
to refresh the lists after NYT changes the dictionary. See README.md for
provenance and licensing.

Two files with very different roles:

  allowed_guesses.txt  Every word the game accepts. Ships to the browser.
  answers.txt          Words NYT has actually used, in puzzle order. Held back
                       from the browser bundle: it is the evaluation set, and a
                       solver that can read its own answer key isn't being
                       measured. Puzzle order is preserved so evaluation can
                       split on time rather than at random.
"""

import json
import pathlib
import urllib.request

DATA = pathlib.Path(__file__).resolve().parent.parent / "data"

GUESSES_URL = "https://raw.githubusercontent.com/tabatkins/wordle-list/main/words"
ANSWERS_URL = "https://raw.githubusercontent.com/stuartpb/wordles/main/wordles.json"


def get(url):
    with urllib.request.urlopen(url) as resp:
        return resp.read().decode("utf-8")


def check(words, name, ordered):
    bad = [w for w in words if len(w) != 5 or not w.isalpha() or not w.islower()]
    if bad:
        raise ValueError(f"{name}: {len(bad)} malformed entries, e.g. {bad[:5]}")
    if len(set(words)) != len(words):
        raise ValueError(f"{name}: contains duplicates")
    if ordered and words != sorted(words):
        raise ValueError(f"{name}: expected alphabetical order")


def write(name, words):
    path = DATA / name
    path.write_text("\n".join(words) + "\n")
    print(f"{path.relative_to(DATA.parent)}: {len(words)} words")


def main():
    DATA.mkdir(exist_ok=True)

    guesses = sorted(w.strip().lower() for w in get(GUESSES_URL).split() if w.strip())
    check(guesses, "allowed_guesses.txt", ordered=True)

    # Deliberately NOT sorted -- this is the puzzle sequence.
    answers = [w.lower() for w in json.loads(get(ANSWERS_URL))]
    check(answers, "answers.txt", ordered=False)

    missing = sorted(set(answers) - set(guesses))
    if missing:
        raise ValueError(
            f"{len(missing)} answers are absent from the guess list, e.g. {missing[:5]}"
        )

    write("allowed_guesses.txt", guesses)
    write("answers.txt", answers)


if __name__ == "__main__":
    main()
