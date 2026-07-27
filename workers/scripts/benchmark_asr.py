import argparse
import json
from pathlib import Path

from audio_workers.contracts import TranscriptionRange, TranscriptionRequest
from audio_workers.transcribe import transcribe_audio


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run ASR against a short range of normalized local audio."
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("--start-ms", type=int, required=True)
    parser.add_argument("--duration-ms", type=int, default=30_000)
    parser.add_argument(
        "--language-mode",
        choices=["AUTO", "ENGLISH", "HINDI_HINGLISH"],
        action="append",
        dest="language_modes",
    )
    args = parser.parse_args()
    end_ms = args.start_ms + args.duration_ms
    results: list[dict[str, object]] = []
    for language_mode in args.language_modes or ["AUTO"]:
        request = TranscriptionRequest(
            analysis_id="local-benchmark",
            chunk_id=f"{args.start_ms}-{end_ms}",
            source_url="http://127.0.0.1/local-benchmark",
            start_ms=args.start_ms,
            end_ms=end_ms,
            ranges=[
                TranscriptionRange(start_ms=args.start_ms, end_ms=end_ms)
            ],
            language_mode=language_mode,
        )
        response = transcribe_audio(
            request,
            ffmpeg_path="ffmpeg",
            timeout_seconds=120,
            normalized_source=args.source,
        )
        results.append(response.model_dump(by_alias=True))
    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
