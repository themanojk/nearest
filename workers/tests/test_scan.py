import math

import numpy as np
import pytest

from audio_workers.contracts import ScanRequest
from audio_workers.scan import AudioScanError, ScanAccumulator, validate_source_url


class AlwaysSpeechDetector:
    def is_speech(self, buffer: bytes, sample_rate: int) -> bool:
        return True


class NeverSpeechDetector:
    def is_speech(self, buffer: bytes, sample_rate: int) -> bool:
        return False


def pcm_tone(
    *,
    duration_ms: int = 1_000,
    sample_rate: int = 16_000,
    frequency: float = 440.0,
    amplitude: float = 0.1,
) -> bytes:
    sample_count = round(duration_ms / 1_000 * sample_rate)
    time = np.arange(sample_count, dtype=np.float64) / sample_rate
    samples = np.sin(2 * math.pi * frequency * time) * amplitude
    return (samples * 32767).astype("<i2").tobytes()


def test_scan_accumulator_detects_high_energy_interval() -> None:
    request = ScanRequest(
        analysis_id="analysis-1",
        source_url="http://127.0.0.1/audio",
        window_ms=1_000,
        overlap_ms=100,
    )
    accumulator = ScanAccumulator(request, detector=AlwaysSpeechDetector())
    accumulator.consume(pcm_tone())
    response = accumulator.finalize(0.1)

    assert response.summary.window_count == 1
    assert response.summary.speech_interval_count == 1
    assert response.summary.speech_ratio > 0.9
    assert response.windows[0].speech_ratio > 0.9
    assert "speech_candidate" in response.windows[0].labels


def test_scan_accumulator_labels_silence() -> None:
    request = ScanRequest(
        analysis_id="analysis-1",
        source_url="http://127.0.0.1/audio",
        window_ms=1_000,
        overlap_ms=100,
    )
    accumulator = ScanAccumulator(request, detector=NeverSpeechDetector())
    accumulator.consume(bytes(16_000 * 2))
    response = accumulator.finalize(0.1)

    assert response.summary.speech_interval_count == 0
    assert response.windows[0].labels == ["silence"]


def test_high_energy_is_not_automatically_classified_as_speech() -> None:
    request = ScanRequest(
        analysis_id="analysis-1",
        source_url="http://127.0.0.1/audio",
        window_ms=1_000,
        overlap_ms=100,
    )
    accumulator = ScanAccumulator(request, detector=NeverSpeechDetector())
    accumulator.consume(pcm_tone(amplitude=0.8))
    response = accumulator.finalize(0.1)

    assert response.windows[0].rms_dbfs > -10
    assert response.summary.speech_interval_count == 0
    assert response.summary.speech_ratio == 0


def test_source_url_is_restricted_to_configured_hosts() -> None:
    validate_source_url(
        "http://127.0.0.1:59000/bucket/object?signature=secret",
        {"127.0.0.1"},
    )

    with pytest.raises(AudioScanError, match="host is not allowed"):
        validate_source_url(
            "http://169.254.169.254/latest/meta-data",
            {"127.0.0.1"},
        )
