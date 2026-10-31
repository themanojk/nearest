import re
import unicodedata
from collections.abc import Iterable


def normalize_for_evaluation(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).casefold()
    normalized = re.sub(r"[^\w]+", " ", normalized, flags=re.UNICODE)
    return re.sub(r"\s+", " ", normalized).strip()


def matched_terms(transcript: str, expected_terms: Iterable[str]) -> set[str]:
    normalized_transcript = f" {normalize_for_evaluation(transcript)} "
    return {
        term
        for term in expected_terms
        if f" {normalize_for_evaluation(term)} " in normalized_transcript
    }


def word_errors(reference: str, hypothesis: str) -> tuple[int, int]:
    reference_words = normalize_for_evaluation(reference).split()
    hypothesis_words = normalize_for_evaluation(hypothesis).split()
    previous = list(range(len(hypothesis_words) + 1))
    for reference_index, reference_word in enumerate(reference_words, start=1):
        current = [reference_index]
        for hypothesis_index, hypothesis_word in enumerate(
            hypothesis_words,
            start=1,
        ):
            substitution_cost = int(reference_word != hypothesis_word)
            current.append(
                min(
                    current[-1] + 1,
                    previous[hypothesis_index] + 1,
                    previous[hypothesis_index - 1] + substitution_cost,
                )
            )
        previous = current
    return previous[-1], len(reference_words)


def precision_recall_f1(
    true_positive: int,
    false_positive: int,
    false_negative: int,
) -> dict[str, float | int]:
    precision = (
        true_positive / (true_positive + false_positive)
        if true_positive + false_positive
        else 0.0
    )
    recall = (
        true_positive / (true_positive + false_negative)
        if true_positive + false_negative
        else 0.0
    )
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall
        else 0.0
    )
    return {
        "truePositive": true_positive,
        "falsePositive": false_positive,
        "falseNegative": false_negative,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
    }
