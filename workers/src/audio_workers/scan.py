import math
import subprocess
import time
from collections import deque
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlsplit

import numpy as np
import webrtcvad  # type: ignore[import-untyped]
from numpy.typing import NDArray

from audio_workers.contracts import (
    ScanRequest,
    ScanResponse,
    ScanSummary,
    ScanWindow,
    SpeechInterval,
)


class AudioScanError(RuntimeError):
    """Raised when streaming decode or Tier-1 analysis fails."""


class VoiceActivityDetector(Protocol):
    def is_speech(self, buffer: bytes, sample_rate: int) -> bool: ...


@dataclass(frozen=True)
class FrameMetric:
    index: int
    rms_dbfs: float
    peak_dbfs: float
    speech: bool


def validate_source_url(source_url: str, allowed_hosts: set[str]) -> None:
    parsed = urlsplit(source_url)
    if parsed.scheme not in {"http", "https"}:
        raise AudioScanError("sourceUrl must use http or https")
    if not parsed.hostname or parsed.hostname.lower() not in allowed_hosts:
        raise AudioScanError("sourceUrl host is not allowed")


def _dbfs(values: NDArray[np.float64]) -> NDArray[np.float64]:
    return 20.0 * np.log10(np.maximum(values, 1e-10))


class ScanAccumulator:
    def __init__(
        self,
        request: ScanRequest,
        detector: VoiceActivityDetector | None = None,
    ) -> None:
        self.request = request
        self.detector = detector or webrtcvad.Vad(request.vad_mode)
        self.frame_samples = round(request.sample_rate * request.frame_ms / 1000)
        self.frame_bytes = self.frame_samples * 2
        self.window_frames = max(1, round(request.window_ms / request.frame_ms))
        overlap_frames = round(request.overlap_ms / request.frame_ms)
        self.hop_frames = max(1, self.window_frames - overlap_frames)
        self.pending = b""
        self.metrics: deque[FrameMetric] = deque()
        self.windows: list[ScanWindow] = []
        self.raw_speech_intervals: list[tuple[int, int, float]] = []
        self.frame_index = 0
        self.last_window_end_frame = 0
        self.speech_start_frame: int | None = None
        self.speech_dbfs: list[float] = []

    def consume(self, chunk: bytes) -> None:
        self.pending += chunk
        process_bytes = len(self.pending) // self.frame_bytes * self.frame_bytes
        if process_bytes == 0:
            return

        pcm = self.pending[:process_bytes]
        self.pending = self.pending[process_bytes:]
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float64)
        frames = samples.reshape(-1, self.frame_samples) / 32768.0
        rms = np.sqrt(np.mean(np.square(frames), axis=1))
        peak = np.max(np.abs(frames), axis=1)
        rms_dbfs = _dbfs(rms)
        peak_dbfs = _dbfs(peak)

        for offset, (rms_value, peak_value) in enumerate(
            zip(rms_dbfs, peak_dbfs, strict=True)
        ):
            frame_start = offset * self.frame_bytes
            frame_pcm = pcm[frame_start : frame_start + self.frame_bytes]
            speech = self.detector.is_speech(frame_pcm, self.request.sample_rate)
            metric = FrameMetric(
                index=self.frame_index,
                rms_dbfs=float(rms_value),
                peak_dbfs=float(peak_value),
                speech=speech,
            )
            self.metrics.append(metric)
            self._track_speech(metric)
            self.frame_index += 1

            if len(self.metrics) >= self.window_frames:
                self._emit_window(self.window_frames)
                for _ in range(min(self.hop_frames, len(self.metrics))):
                    self.metrics.popleft()

    def finalize(self, processing_seconds: float) -> ScanResponse:
        if self.speech_start_frame is not None:
            self._close_speech_interval(self.frame_index)
        if (
            self.metrics
            and self.metrics[-1].index + 1 > self.last_window_end_frame
        ):
            self._emit_window(len(self.metrics))

        intervals = self._merge_speech_intervals()
        decoded_duration_ms = self.frame_index * self.request.frame_ms
        speech_duration_ms = sum(
            interval.end_ms - interval.start_ms for interval in intervals
        )
        speech_ratio = (
            speech_duration_ms / decoded_duration_ms
            if decoded_duration_ms > 0
            else 0.0
        )

        return ScanResponse(
            analysis_id=self.request.analysis_id,
            pipeline_version="webrtc-vad/1.0.0",
            capabilities=["webrtc_vad", "audio_quality", "logical_windows"],
            sample_rate=self.request.sample_rate,
            vad_mode=self.request.vad_mode,
            windows=self.windows,
            speech_intervals=intervals,
            summary=ScanSummary(
                decoded_duration_ms=decoded_duration_ms,
                processing_seconds=round(processing_seconds, 3),
                speech_duration_ms=speech_duration_ms,
                speech_ratio=round(speech_ratio, 6),
                window_count=len(self.windows),
                speech_interval_count=len(intervals),
            ),
        )

    def _track_speech(self, metric: FrameMetric) -> None:
        if metric.speech:
            if self.speech_start_frame is None:
                self.speech_start_frame = metric.index
            self.speech_dbfs.append(metric.rms_dbfs)
        elif self.speech_start_frame is not None:
            self._close_speech_interval(metric.index)

    def _close_speech_interval(self, end_frame: int) -> None:
        if self.speech_start_frame is None:
            return
        mean_dbfs = float(np.mean(self.speech_dbfs))
        confidence = float(np.clip((mean_dbfs + 70.0) / 50.0, 0.0, 1.0))
        self.raw_speech_intervals.append(
            (self.speech_start_frame, end_frame, confidence)
        )
        self.speech_start_frame = None
        self.speech_dbfs = []

    def _emit_window(self, count: int) -> None:
        frames = list(self.metrics)[:count]
        if not frames:
            return
        rms_linear = np.array(
            [10 ** (frame.rms_dbfs / 20.0) for frame in frames],
            dtype=np.float64,
        )
        rms_dbfs = 20.0 * math.log10(
            max(float(np.sqrt(np.mean(np.square(rms_linear)))), 1e-10)
        )
        peak_dbfs = max(frame.peak_dbfs for frame in frames)
        speech_ratio = sum(frame.speech for frame in frames) / len(frames)
        labels: list[str] = []
        if rms_dbfs <= -60:
            labels.append("silence")
        elif rms_dbfs <= -50:
            labels.append("low_signal")
        if speech_ratio >= 0.2:
            labels.append("speech_candidate")
        if peak_dbfs >= -1:
            labels.append("clipping_candidate")

        self.windows.append(
            ScanWindow(
                start_ms=frames[0].index * self.request.frame_ms,
                end_ms=(frames[-1].index + 1) * self.request.frame_ms,
                speech_ratio=round(speech_ratio, 6),
                rms_dbfs=round(rms_dbfs, 3),
                peak_dbfs=round(peak_dbfs, 3),
                labels=labels,
            )
        )
        self.last_window_end_frame = frames[-1].index + 1

    def _merge_speech_intervals(self) -> list[SpeechInterval]:
        minimum_frames = max(1, round(150 / self.request.frame_ms))
        merge_gap_frames = max(1, round(300 / self.request.frame_ms))
        filtered = [
            interval
            for interval in self.raw_speech_intervals
            if interval[1] - interval[0] >= minimum_frames
        ]
        merged: list[tuple[int, int, float]] = []
        for start, end, confidence in filtered:
            if merged and start - merged[-1][1] <= merge_gap_frames:
                previous = merged[-1]
                merged[-1] = (
                    previous[0],
                    end,
                    max(previous[2], confidence),
                )
            else:
                merged.append((start, end, confidence))

        return [
            SpeechInterval(
                start_ms=start * self.request.frame_ms,
                end_ms=end * self.request.frame_ms,
                confidence=round(confidence, 6),
            )
            for start, end, confidence in merged
        ]


def scan_audio(
    request: ScanRequest,
    *,
    ffmpeg_path: str,
    timeout_seconds: int,
) -> ScanResponse:
    started_at = time.monotonic()
    accumulator = ScanAccumulator(request)
    process = subprocess.Popen(
        [
            ffmpeg_path,
            "-nostdin",
            "-v",
            "error",
            "-i",
            request.source_url,
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            str(request.sample_rate),
            "-f",
            "s16le",
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        if process.stdout is None:
            raise AudioScanError("FFmpeg stdout was not available")
        while chunk := process.stdout.read(64 * 1024):
            if time.monotonic() - started_at > timeout_seconds:
                raise AudioScanError("Audio scan exceeded its time limit")
            accumulator.consume(chunk)

        return_code = process.wait(timeout=10)
        if return_code != 0:
            raise AudioScanError("FFmpeg could not decode the audio object")
        return accumulator.finalize(time.monotonic() - started_at)
    finally:
        if process.poll() is None:
            process.kill()
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()
