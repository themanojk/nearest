from pathlib import Path

import pytest

from audio_workers.lexicon import LexiconError, load_hotwords


def test_hotword_lexicon_loads_canonical_terms_and_variants(
    tmp_path: Path,
) -> None:
    lexicon = tmp_path / "hotwords.tsv"
    lexicon.write_text(
        "canonical\tcategory\tvariants\n"
        "saala\tinsult\tsaale|साले|saale\n"
        "kameena\tinsult\tkameene\n",
        encoding="utf-8",
    )

    assert load_hotwords(str(lexicon)).split() == [
        "saala",
        "saale",
        "साले",
        "kameena",
        "kameene",
    ]


def test_missing_hotword_lexicon_is_a_configuration_error(
    tmp_path: Path,
) -> None:
    with pytest.raises(LexiconError, match="was not found"):
        load_hotwords(str(tmp_path / "missing.tsv"))
