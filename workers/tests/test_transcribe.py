import wave
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest
from faster_whisper import WhisperModel  # type: ignore[import-untyped]
from pydantic import ValidationError

from audio_workers.contracts import (
    TranscriptionRange,
    TranscriptionRequest,
    TranscriptWord,
)
from audio_workers.transcribe import (
    _is_repetitive_hallucination,
    map_clip_time_to_source,
    transcribe_audio,
)


class FakeModel:
    def transcribe(
        self, audio: str, **kwargs: object
    ) -> tuple[list[SimpleNamespace], SimpleNamespace]:
        return (
            [
                SimpleNamespace(
                    text=" hello world ",
                    words=[
                        SimpleNamespace(
                            start=0.25,
                            end=0.7,
                            word=" hello",
                            probability=0.92,
                        ),
                        SimpleNamespace(
                            start=0.72,
                            end=1.1,
                            word=" world",
                            probability=0.88,
                        ),
                    ],
                )
            ],
            SimpleNamespace(language="en", language_probability=0.98),
        )


class RetryFakeModel:
    def __init__(self) -> None:
        self.languages: list[str | None] = []

    def transcribe(
        self, audio: str, **kwargs: object
    ) -> tuple[list[SimpleNamespace], SimpleNamespace]:
        language = kwargs.get("language")
        self.languages.append(
            language if isinstance(language, str) else None
        )
        if language == "hi":
            return (
                [
                    SimpleNamespace(
                        words=[
                            SimpleNamespace(
                                start=0.2,
                                end=0.6,
                                word=" नमस्ते",
                                probability=0.84,
                            ),
                            SimpleNamespace(
                                start=0.7,
                                end=1.1,
                                word=" school",
                                probability=0.8,
                            ),
                        ]
                    )
                ],
                SimpleNamespace(
                    language="hi",
                    language_probability=0.94,
                ),
            )
        if language == "en":
            return (
                [
                    SimpleNamespace(
                        words=[
                            SimpleNamespace(
                                start=0.2,
                                end=0.6,
                                word=" noise",
                                probability=0.55,
                            )
                        ]
                    )
                ],
                SimpleNamespace(
                    language="en",
                    language_probability=0.8,
                ),
            )
        return (
            [
                SimpleNamespace(
                    words=[
                        SimpleNamespace(
                            start=0.2,
                            end=0.6,
                            word=" 대박이에요",
                            probability=0.96,
                        )
                    ]
                )
            ],
            SimpleNamespace(
                language="ko",
                language_probability=0.75,
            ),
        )


def make_wave(path: Path, duration_seconds: int = 30) -> Path:
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16_000)
        audio.writeframes(b"\x00\x00" * 16_000 * duration_seconds)
    return path


def test_transcription_maps_words_to_the_original_timeline(
    tmp_path: Path,
) -> None:
    request = TranscriptionRequest(
        analysis_id="analysis-1",
        chunk_id="chunk-1",
        source_url="http://127.0.0.1/audio",
        start_ms=10_000,
        end_ms=20_000,
        ranges=[TranscriptionRange(start_ms=10_000, end_ms=20_000)],
    )
    response = transcribe_audio(
        request,
        ffmpeg_path="ffmpeg",
        timeout_seconds=30,
        model=cast(WhisperModel, FakeModel()),
        normalized_source=make_wave(tmp_path / "source.wav"),
    )

    assert response.text == "hello world"
    assert response.language == "en"
    assert response.words[0].start_ms == 10_250
    assert response.words[0].end_ms == 10_700
    assert response.extraction_seconds >= 0
    assert response.inference_seconds >= 0


def test_transcription_rejects_oversized_ranges() -> None:
    with pytest.raises(ValidationError, match="must not exceed 120 seconds"):
        TranscriptionRequest(
            analysis_id="analysis-1",
            chunk_id="chunk-1",
            source_url="http://127.0.0.1/audio",
            start_ms=0,
            end_ms=120_001,
            ranges=[TranscriptionRange(start_ms=0, end_ms=120_001)],
        )


def test_discontinuous_clip_time_maps_back_to_source() -> None:
    request = TranscriptionRequest(
        analysis_id="analysis-1",
        chunk_id="chunk-1",
        source_url="http://127.0.0.1/audio",
        start_ms=1_000,
        end_ms=12_000,
        ranges=[
            TranscriptionRange(start_ms=1_000, end_ms=3_000),
            TranscriptionRange(start_ms=10_000, end_ms=12_000),
        ],
    )

    assert map_clip_time_to_source(request, 1_500) == 2_500
    assert map_clip_time_to_source(request, 2_500) == 10_500


def test_repeated_token_hallucination_is_rejected() -> None:
    words = [
        TranscriptWord(start_ms=index, end_ms=index + 1, text=" ө")
        for index in range(20)
    ]

    assert _is_repetitive_hallucination(words)


def test_auto_mode_retries_wrong_script_and_selects_hinglish(
    tmp_path: Path,
) -> None:
    request = TranscriptionRequest(
        analysis_id="analysis-1",
        chunk_id="chunk-1",
        source_url="http://127.0.0.1/audio",
        start_ms=10_000,
        end_ms=20_000,
        ranges=[TranscriptionRange(start_ms=10_000, end_ms=20_000)],
        language_mode="AUTO",
    )
    model = RetryFakeModel()

    response = transcribe_audio(
        request,
        ffmpeg_path="ffmpeg",
        timeout_seconds=30,
        model=cast(WhisperModel, model),
        normalized_source=make_wave(tmp_path / "source.wav"),
    )

    assert response.text == "नमस्ते school"
    assert response.language == "hi"
    assert response.quality_retry_used
    assert model.languages == [None, "hi", "en"]
