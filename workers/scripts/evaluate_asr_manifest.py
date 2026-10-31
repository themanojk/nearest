import argparse
import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from audio_workers.context import classify_context
from audio_workers.contracts import (
    ContextClassificationRequest,
    ContextSession,
    ContextUtterance,
    TranscriptionRange,
    TranscriptionRequest,
)
from audio_workers.evaluation import (
    matched_terms,
    precision_recall_f1,
    word_errors,
)
from audio_workers.transcribe import transcribe_audio


class EvaluationCase(BaseModel):
    case_id: str = Field(alias="id")
    audio_path: str = Field(alias="audioPath")
    start_ms: int = Field(default=0, alias="startMs")
    end_ms: int = Field(alias="endMs")
    language_mode: Literal["AUTO", "ENGLISH", "HINDI_HINGLISH"] = Field(
        default="AUTO",
        alias="languageMode",
    )
    expected_terms: list[str] = Field(default_factory=list, alias="expectedTerms")
    expected_signals: list[str] = Field(
        default_factory=list,
        alias="expectedSignals",
    )
    reference_text: str = Field(alias="referenceText")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate ASR term recall and downstream safety signals."
    )
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    manifest_path = args.manifest.resolve()
    cases = _read_cases(manifest_path)

    expected_term_count = 0
    matched_term_count = 0
    signal_tp = 0
    signal_fp = 0
    signal_fn = 0
    total_word_errors = 0
    total_reference_words = 0
    results: list[dict[str, object]] = []
    for case in cases:
        audio_path = Path(case.audio_path)
        if not audio_path.is_absolute():
            audio_path = manifest_path.parent / audio_path
        response = transcribe_audio(
            TranscriptionRequest(
                analysis_id=f"evaluation-{case.case_id}",
                chunk_id=case.case_id,
                source_url="http://127.0.0.1/evaluation",
                start_ms=case.start_ms,
                end_ms=case.end_ms,
                ranges=[
                    TranscriptionRange(
                        start_ms=case.start_ms,
                        end_ms=case.end_ms,
                    )
                ],
                language_mode=case.language_mode,
            ),
            ffmpeg_path="ffmpeg",
            timeout_seconds=120,
            normalized_source=audio_path,
        )
        found_terms = matched_terms(response.text, case.expected_terms)
        case_word_errors, case_reference_words = word_errors(
            case.reference_text,
            response.text,
        )
        predicted_signals = _classify_signals(case, response.text)
        expected_signals = set(case.expected_signals)
        expected_term_count += len(case.expected_terms)
        matched_term_count += len(found_terms)
        signal_tp += len(predicted_signals & expected_signals)
        signal_fp += len(predicted_signals - expected_signals)
        signal_fn += len(expected_signals - predicted_signals)
        total_word_errors += case_word_errors
        total_reference_words += case_reference_words
        results.append(
            {
                "id": case.case_id,
                "transcript": response.text,
                "referenceText": case.reference_text,
                "wordErrorRate": round(
                    case_word_errors / case_reference_words,
                    4,
                )
                if case_reference_words
                else None,
                "expectedTerms": case.expected_terms,
                "missedTerms": sorted(set(case.expected_terms) - found_terms),
                "expectedSignals": sorted(expected_signals),
                "predictedSignals": sorted(predicted_signals),
                "qualityRetryUsed": response.quality_retry_used,
            }
        )

    report = {
        "caseCount": len(cases),
        "termRecall": round(
            matched_term_count / expected_term_count,
            4,
        )
        if expected_term_count
        else None,
        "matchedTermCount": matched_term_count,
        "expectedTermCount": expected_term_count,
        "wordErrorRate": round(
            total_word_errors / total_reference_words,
            4,
        )
        if total_reference_words
        else None,
        "signals": precision_recall_f1(signal_tp, signal_fp, signal_fn),
        "cases": results,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


def _read_cases(path: Path) -> list[EvaluationCase]:
    cases: list[EvaluationCase] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                cases.append(EvaluationCase.model_validate_json(line))
            except ValueError as error:
                raise ValueError(
                    f"Invalid evaluation case at {path}:{line_number}"
                ) from error
    return cases


def _classify_signals(case: EvaluationCase, text: str) -> set[str]:
    response = classify_context(
        ContextClassificationRequest(
            analysis_id=f"evaluation-{case.case_id}",
            sessions=[
                ContextSession(
                    session_id=case.case_id,
                    start_ms=case.start_ms,
                    end_ms=case.end_ms,
                    speakers=["SPEAKER_01"],
                    utterances=[
                        ContextUtterance(
                            start_ms=case.start_ms,
                            end_ms=case.end_ms,
                            speaker_id="SPEAKER_01",
                            text=text,
                        )
                    ],
                )
            ],
        )
    )
    return {
        signal.signal_type
        for signal in response.sessions[0].safety_signals
    }


if __name__ == "__main__":
    main()
