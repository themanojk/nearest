import numpy as np

from audio_workers.contracts import DiarizationRequest
from audio_workers.diarize import (
    MODEL_NAME,
    _cluster_embeddings,
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
    embeddings = [
        embedding / np.linalg.norm(embedding)
        for embedding in embeddings
    ]

    labels, confidences = _cluster_embeddings(
        embeddings,
        [2_000, 2_000, 2_000, 2_000],
    )

    assert labels[0] == labels[1]
    assert labels[2] == labels[3]
    assert labels[0] != labels[2]
    assert all(confidence > 0.9 for confidence in confidences)
