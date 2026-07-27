import wave
from pathlib import Path

from audio_workers.contracts import TranscriptionRange, TranscriptionRequest
from audio_workers.transcribe import _assemble_ranges


def test_direct_pcm_assembly_concatenates_selected_ranges(
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.wav"
    with wave.open(str(source_path), "wb") as source:
        source.setnchannels(1)
        source.setsampwidth(2)
        source.setframerate(16_000)
        source.writeframes(
            b"\x01\x00" * 16_000
            + b"\x02\x00" * 16_000
            + b"\x03\x00" * 16_000
        )
    request = TranscriptionRequest(
        analysis_id="analysis-1",
        chunk_id="chunk-1",
        source_url="http://localhost/source.wav",
        start_ms=0,
        end_ms=3_000,
        ranges=[
            TranscriptionRange(start_ms=0, end_ms=1_000),
            TranscriptionRange(start_ms=2_000, end_ms=3_000),
        ],
    )
    output_path = tmp_path / "clip.wav"

    _assemble_ranges(source_path, output_path, request)

    with wave.open(str(output_path), "rb") as output:
        frames = output.readframes(output.getnframes())
    assert len(frames) == 2 * 16_000 * 2
    assert frames[:2] == b"\x01\x00"
    assert frames[-2:] == b"\x03\x00"
