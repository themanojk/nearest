from audio_workers.evaluation import (
    matched_terms,
    precision_recall_f1,
    word_errors,
)


def test_term_matching_normalizes_case_punctuation_and_script() -> None:
    assert matched_terms(
        "Abe SAALE! तुम बदतमीज़ हो.",
        ["saale", "बदतमीज़", "kameena"],
    ) == {"saale", "बदतमीज़"}


def test_precision_recall_report() -> None:
    assert precision_recall_f1(8, 2, 4) == {
        "truePositive": 8,
        "falsePositive": 2,
        "falseNegative": 4,
        "precision": 0.8,
        "recall": 0.6667,
        "f1": 0.7273,
    }


def test_word_errors_count_substitutions_insertions_and_deletions() -> None:
    assert word_errors("tu saale idhar aa", "tu sale aa") == (2, 4)
