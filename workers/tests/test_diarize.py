import wave
from pathlib import Path

import numpy as np

from audio_workers.contracts import DiarizationRequest, DiarizationWord
from audio_workers.diarize import (
    MODEL_NAME,
    _assemble_utterances,
    _cluster_embeddings,
    _group_words,
    diarize_audio,
)


def test_empty_transcript_completes_without_extracting_audio() -> None:
    result = diarize_audio(
        DiarizationRequest(
            analysis_id="analysis-1",
            source_url="http://localhost/audio.wav",
            words=[],
        ),
        ffmpeg_path="ffmpeg",
        timeout_seconds=1,
    )

    assert result.analysis_id == "analysis-1"
    assert result.model == MODEL_NAME
    assert result.speaker_count == 0
    assert result.turns == []


def test_learned_embeddings_keep_distinct_speakers_separate() -> None:
    embeddings = [
        np.asarray([1.0, 0.0, 0.0], dtype=np.float32),
        np.asarray([0.99, 0.1, 0.0], dtype=np.float32),
        np.asarray([0.0, 1.0, 0.0], dtype=np.float32),
        np.asarray([0.1, 0.99, 0.0], dtype=np.float32),
    ]
    embeddings = [embedding / np.linalg.norm(embedding) for embedding in embeddings]

    labels, confidences = _cluster_embeddings(
        embeddings,
        [2_000, 2_000, 2_000, 2_000],
    )

    assert labels[0] == labels[1]
    assert labels[2] == labels[3]
    assert labels[0] != labels[2]
    assert all(confidence > 0.9 for confidence in confidences)


def test_diarization_assembly_reuses_local_normalized_audio(
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.wav"
    with wave.open(str(source_path), "wb") as source:
        source.setnchannels(1)
        source.setsampwidth(2)
        source.setframerate(16_000)
        source.writeframes(b"\x01\x00" * 16_000 * 3)
    utterances = _group_words(
        [
            DiarizationWord(start_ms=500, end_ms=1_000, text=" first"),
            DiarizationWord(start_ms=2_000, end_ms=2_500, text=" second"),
        ]
    )
    output_path = tmp_path / "utterances.wav"

    _assemble_utterances(source_path, utterances, output_path)

    with wave.open(str(output_path), "rb") as output:
        assert output.getnframes() == 16_000 * 1_600 // 1_000
    assert utterances[0].clip_start_ms == 0
    assert utterances[-1].clip_end_ms == 1_600
