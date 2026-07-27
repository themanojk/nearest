import argparse
import json
import wave
from pathlib import Path

import numpy as np

from audio_workers.acoustic import _classify_window
from audio_workers.config import settings


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Report peak health-label probabilities in normalized audio."
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("--window-ms", type=int, default=2_000)
    parser.add_argument("--hop-ms", type=int, default=500)
    parser.add_argument("--top", type=int, default=20)
    args = parser.parse_args()

    with wave.open(str(args.source), "rb") as audio:
        sample_rate = audio.getframerate()
        samples = np.frombuffer(
            audio.readframes(audio.getnframes()), dtype="<i2"
        ).astype(np.float32) / 32768.0

    settings.acoustic_min_probability = 0
    window_samples = round(args.window_ms * sample_rate / 1_000)
    hop_samples = round(args.hop_ms * sample_rate / 1_000)
    target_labels = {"Cough", "Wheeze", "Gasp"}
    detections: list[dict[str, object]] = []
    for start_sample in range(0, samples.size, hop_samples):
        window = samples[start_sample : start_sample + window_samples]
        start_ms = round(start_sample * 1_000 / sample_rate)
        for label, confidence in _classify_window(window, sample_rate):
            if label in target_labels:
                detections.append(
                    {
                        "startMs": start_ms,
                        "endMs": start_ms + args.window_ms,
                        "label": label,
                        "confidence": round(confidence, 6),
                    }
                )
        if start_sample + window_samples >= samples.size:
            break

    detections.sort(
        key=lambda item: float(item["confidence"]), reverse=True
    )
    print(json.dumps(detections[: args.top], indent=2))


if __name__ == "__main__":
    main()
