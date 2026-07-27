import csv
import subprocess
import tempfile
import time
import wave
from collections.abc import Callable
from functools import lru_cache
from pathlib import Path
from typing import cast

import kaldi_native_fbank as knf  # type: ignore[import-untyped]
import numpy as np
import onnxruntime as ort  # type: ignore[import-untyped]

from audio_workers.config import settings
from audio_workers.contracts import (
    AcousticDetectionRequest,
    AcousticDetectionResponse,
    AcousticEvent,
)

MODEL_NAME = (
    "sherpa-onnx-zipformer-small-audio-tagging/"
    "2024-04-15-int8+health-multires/1.1.0"
)

EVENT_CLASSES: dict[str, tuple[str, str]] = {
    "Shout": ("distress_vocalization", "medium"),
    "Yell": ("distress_vocalization", "medium"),
    "Children shouting": ("distress_vocalization", "medium"),
    "Screaming": ("distress_vocalization", "high"),
    "Crying, sobbing": ("distress_vocalization", "medium"),
    "Baby cry, infant cry": ("distress_vocalization", "medium"),
    "Whimper": ("distress_vocalization", "medium"),
    "Wail, moan": ("distress_vocalization", "medium"),
    "Wheeze": ("health_sound", "medium"),
    "Gasp": ("health_sound", "high"),
    "Cough": ("health_sound", "low"),
    "Alarm": ("alarm", "medium"),
    "Siren": ("alarm", "medium"),
    "Civil defense siren": ("alarm", "high"),
    "Smoke detector, smoke alarm": ("alarm", "high"),
    "Fire alarm": ("alarm", "high"),
    "Explosion": ("hazard", "high"),
    "Gunshot, gunfire": ("hazard", "high"),
    "Firecracker": ("hazard", "medium"),
    "Boom": ("impact", "medium"),
    "Shatter": ("impact", "high"),
    "Thump, thud": ("impact", "medium"),
    "Bang": ("impact", "medium"),
    "Slap, smack": ("impact", "high"),
    "Whack, thwack": ("impact", "high"),
    "Smash, crash": ("impact", "high"),
    "Breaking": ("impact", "high"),
}

HEALTH_THRESHOLDS: dict[str, Callable[[], float]] = {
    "Cough": lambda: settings.health_cough_min_probability,
    "Wheeze": lambda: settings.health_wheeze_min_probability,
    "Gasp": lambda: settings.health_gasp_min_probability,
}


class AcousticDetectionError(RuntimeError):
    """Raised when acoustic-event extraction or inference fails."""


def detect_acoustic_events(
    request: AcousticDetectionRequest,
    *,
    ffmpeg_path: str,
    timeout_seconds: int,
) -> AcousticDetectionResponse:
    started_at = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="kid-audio-acoustic-") as directory:
        clip_path = Path(directory) / "clip.wav"
        _extract_ranges(
            request,
            clip_path,
            ffmpeg_path=ffmpeg_path,
            timeout_seconds=timeout_seconds,
        )
        samples, sample_rate = _read_wave(clip_path)

    window_samples = round(settings.acoustic_window_ms * sample_rate / 1_000)
    window_count = max(1, int(np.ceil(samples.size / window_samples)))
    events: list[AcousticEvent] = []
    for window_index in range(window_count):
        clip_start_ms = window_index * settings.acoustic_window_ms
        clip_end_ms = min(
            round(samples.size * 1_000 / sample_rate),
            clip_start_ms + settings.acoustic_window_ms,
        )
        window = samples[
            window_index * window_samples : (window_index + 1) * window_samples
        ]
        for label, confidence in _classify_window(window, sample_rate):
            category, severity = EVENT_CLASSES[label]
            if category == "health_sound":
                continue
            for source_start_ms, source_end_ms in _map_clip_interval_to_source(
                request,
                clip_start_ms,
                clip_end_ms,
            ):
                events.append(
                    AcousticEvent(
                        start_ms=source_start_ms,
                        end_ms=source_end_ms,
                        label=label,
                        category=category,
                        severity=severity,
                        confidence=round(confidence, 4),
                    )
                )

    health_window_count, health_detections = _detect_health_events(
        samples,
        sample_rate,
    )
    for clip_start_ms, clip_end_ms, label, confidence in health_detections:
        category, severity = EVENT_CLASSES[label]
        for source_start_ms, source_end_ms in _map_clip_interval_to_source(
            request,
            clip_start_ms,
            clip_end_ms,
        ):
            events.append(
                AcousticEvent(
                    start_ms=source_start_ms,
                    end_ms=source_end_ms,
                    label=label,
                    category=category,
                    severity=severity,
                    confidence=round(confidence, 4),
                )
            )

    return AcousticDetectionResponse(
        analysis_id=request.analysis_id,
        chunk_id=request.chunk_id,
        model=MODEL_NAME,
        processing_seconds=round(time.monotonic() - started_at, 3),
        window_count=window_count + health_window_count,
        events=events,
    )


def _detect_health_events(
    samples: np.ndarray,
    sample_rate: int,
) -> tuple[int, list[tuple[int, int, str, float]]]:
    window_samples = round(
        settings.health_window_ms * sample_rate / 1_000
    )
    hop_samples = round(settings.health_hop_ms * sample_rate / 1_000)
    minimum_probability = min(
        threshold() for threshold in HEALTH_THRESHOLDS.values()
    )
    detections: list[tuple[int, int, str, float]] = []
    window_count = 0
    for start_sample in range(0, max(1, samples.size), hop_samples):
        window = samples[start_sample : start_sample + window_samples]
        if window.size == 0:
            break
        window_count += 1
        start_ms = round(start_sample * 1_000 / sample_rate)
        end_ms = min(
            round(samples.size * 1_000 / sample_rate),
            start_ms + settings.health_window_ms,
        )
        for label, confidence in _classify_window(
            window,
            sample_rate,
            minimum_probability=minimum_probability,
        ):
            threshold = HEALTH_THRESHOLDS.get(label)
            if threshold is None or confidence < threshold():
                continue
            detections.append((start_ms, end_ms, label, confidence))
        if start_sample + window_samples >= samples.size:
            break
    return window_count, _merge_health_detections(detections)


def _merge_health_detections(
    detections: list[tuple[int, int, str, float]],
) -> list[tuple[int, int, str, float]]:
    merged: list[tuple[int, int, str, float]] = []
    for start_ms, end_ms, label, confidence in sorted(
        detections, key=lambda item: (item[2], item[0])
    ):
        previous = merged[-1] if merged else None
        if (
            previous
            and previous[2] == label
            and start_ms <= previous[1] + settings.health_merge_gap_ms
        ):
            merged[-1] = (
                previous[0],
                max(previous[1], end_ms),
                label,
                max(previous[3], confidence),
            )
            continue
        merged.append((start_ms, end_ms, label, confidence))
    return sorted(merged, key=lambda item: item[0])


def _extract_ranges(
    request: AcousticDetectionRequest,
    output_path: Path,
    *,
    ffmpeg_path: str,
    timeout_seconds: int,
) -> None:
    command = [ffmpeg_path, "-nostdin", "-v", "error"]
    for selected_range in request.ranges:
        command.extend(
            [
                "-ss",
                f"{selected_range.start_ms / 1_000:.3f}",
                "-t",
                f"{(selected_range.end_ms - selected_range.start_ms) / 1_000:.3f}",
                "-i",
                request.source_url,
            ]
        )
    if len(request.ranges) == 1:
        command.extend(["-map", "0:a:0"])
    else:
        inputs = "".join(
            f"[{index}:a:0]" for index in range(len(request.ranges))
        )
        command.extend(
            [
                "-filter_complex",
                f"{inputs}concat=n={len(request.ranges)}:v=0:a=1[out]",
                "-map",
                "[out]",
            ]
        )
    command.extend(
        [
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-y",
            str(output_path),
        ]
    )
    process = subprocess.run(
        command,
        capture_output=True,
        timeout=timeout_seconds,
        check=False,
    )
    if process.returncode != 0 or not output_path.exists():
        raise AcousticDetectionError(
            "FFmpeg could not extract the acoustic-event ranges"
        )


def _read_wave(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as audio:
        sample_rate = audio.getframerate()
        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2")
    return samples.astype(np.float32) / 32768.0, sample_rate


@lru_cache(maxsize=1)
def _tagging_session() -> ort.InferenceSession:
    model_path = Path(settings.acoustic_model_path)
    if not model_path.is_file():
        raise AcousticDetectionError(
            f"Audio-tagging model was not found at {model_path}"
        )
    return ort.InferenceSession(
        str(model_path),
        providers=["CPUExecutionProvider"],
    )


@lru_cache(maxsize=1)
def _labels() -> list[str]:
    labels_path = Path(settings.acoustic_labels_path)
    if not labels_path.is_file():
        raise AcousticDetectionError(
            f"Audio-tagging labels were not found at {labels_path}"
        )
    with labels_path.open(newline="", encoding="utf-8") as handle:
        return [row["display_name"] for row in csv.DictReader(handle)]


def _classify_window(
    samples: np.ndarray,
    sample_rate: int,
    *,
    minimum_probability: float | None = None,
) -> list[tuple[str, float]]:
    if sample_rate != 16_000:
        raise AcousticDetectionError("Audio tagging requires 16 kHz audio")
    minimum_samples = round(sample_rate * 0.5)
    if samples.size == 0:
        samples = np.zeros(minimum_samples, dtype=np.float32)
    elif samples.size < minimum_samples:
        samples = np.pad(samples, (0, minimum_samples - samples.size))

    options = knf.FbankOptions()
    options.frame_opts.dither = 0
    options.frame_opts.snip_edges = False
    options.frame_opts.samp_freq = sample_rate
    options.frame_opts.frame_shift_ms = 10
    options.frame_opts.frame_length_ms = 25
    options.frame_opts.remove_dc_offset = True
    options.frame_opts.preemph_coeff = 0.97
    options.frame_opts.window_type = "povey"
    options.frame_opts.round_to_power_of_two = True
    options.mel_opts.num_bins = 80
    options.mel_opts.low_freq = 20
    options.mel_opts.high_freq = -400

    extractor = knf.OnlineFbank(options)
    extractor.accept_waveform(sample_rate, samples.tolist())
    extractor.input_finished()
    frame_count = extractor.num_frames_ready
    if frame_count <= 0:
        raise AcousticDetectionError("Could not extract audio-tagging features")
    features = np.asarray(
        [extractor.get_frame(index) for index in range(frame_count)],
        dtype=np.float32,
    )
    output = _tagging_session().run(
        None,
        {
            "x": features[np.newaxis, :, :],
            "x_lens": np.asarray([frame_count], dtype=np.int64),
        },
    )
    probabilities = cast(np.ndarray, output[0])[0]
    labels = _labels()
    return sorted(
        (
            (labels[index], float(probability))
            for index, probability in enumerate(probabilities)
            if labels[index] in EVENT_CLASSES
            and probability
            >= (
                settings.acoustic_min_probability
                if minimum_probability is None
                else minimum_probability
            )
        ),
        key=lambda item: item[1],
        reverse=True,
    )


def _map_clip_interval_to_source(
    request: AcousticDetectionRequest,
    clip_start_ms: int,
    clip_end_ms: int,
) -> list[tuple[int, int]]:
    intersections: list[tuple[int, int]] = []
    elapsed_ms = 0
    for selected_range in request.ranges:
        duration_ms = selected_range.end_ms - selected_range.start_ms
        overlap_start = max(clip_start_ms, elapsed_ms)
        overlap_end = min(clip_end_ms, elapsed_ms + duration_ms)
        if overlap_end > overlap_start:
            intersections.append(
                (
                    selected_range.start_ms + overlap_start - elapsed_ms,
                    selected_range.start_ms + overlap_end - elapsed_ms,
                )
            )
        elapsed_ms += duration_ms
        if elapsed_ms >= clip_end_ms:
            break
    return intersections
