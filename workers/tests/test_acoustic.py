from audio_workers.acoustic import (
    _map_clip_interval_to_source,
    _merge_health_detections,
)
from audio_workers.contracts import (
    AcousticDetectionRequest,
    AcousticRange,
)


def test_acoustic_window_is_split_across_original_source_ranges() -> None:
    request = AcousticDetectionRequest(
        analysis_id="analysis-1",
        chunk_id="chunk-1",
        source_url="http://localhost/audio.wav",
        ranges=[
            AcousticRange(start_ms=1_000, end_ms=5_000),
            AcousticRange(start_ms=20_000, end_ms=27_000),
        ],
    )

    assert _map_clip_interval_to_source(request, 2_000, 9_000) == [
        (3_000, 5_000),
        (20_000, 25_000),
    ]


def test_acoustic_window_stays_on_original_timeline() -> None:
    request = AcousticDetectionRequest(
        analysis_id="analysis-1",
        chunk_id="chunk-1",
        source_url="http://localhost/audio.wav",
        ranges=[AcousticRange(start_ms=100_000, end_ms=110_000)],
    )

    assert _map_clip_interval_to_source(request, 1_000, 6_000) == [
        (101_000, 106_000)
    ]


def test_overlapping_health_windows_become_one_episode() -> None:
    assert _merge_health_detections(
        [
            (108_000, 110_000, "Cough", 0.7537),
            (109_000, 111_000, "Cough", 0.6298),
            (120_000, 122_000, "Cough", 0.8),
        ]
    ) == [
        (108_000, 111_000, "Cough", 0.7537),
        (120_000, 122_000, "Cough", 0.8),
    ]
