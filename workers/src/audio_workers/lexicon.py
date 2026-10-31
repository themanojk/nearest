import csv
from functools import lru_cache
from pathlib import Path


class LexiconError(RuntimeError):
    """Raised when a configured ASR vocabulary cannot be loaded."""


@lru_cache(maxsize=8)
def load_hotwords(path_value: str) -> str:
    path = Path(path_value)
    if not path.is_file():
        raise LexiconError(f"ASR hotword lexicon was not found at {path}")

    terms: list[str] = []
    seen: set[str] = set()
    try:
        with path.open(newline="", encoding="utf-8") as handle:
            for row in csv.DictReader(handle, delimiter="\t"):
                canonical = (row.get("canonical") or "").strip()
                variants = (row.get("variants") or "").split("|")
                for term in [canonical, *variants]:
                    normalized = term.strip()
                    key = normalized.casefold()
                    if normalized and key not in seen:
                        seen.add(key)
                        terms.append(normalized)
    except (OSError, csv.Error) as error:
        raise LexiconError(f"Could not read ASR hotword lexicon at {path}") from error

    if not terms:
        raise LexiconError(f"ASR hotword lexicon at {path} is empty")
    return " ".join(terms)
