import subprocess
import tempfile
import time
import wave
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import cast

import kaldi_native_fbank as knf  # type: ignore[import-untyped]
import numpy as np
import onnxruntime as ort  # type: ignore[import-untyped]

from audio_workers.config import settings
from audio_workers.contracts import (
    DiarizationRequest,
    DiarizationResponse,
    DiarizationWord,
    SpeakerTurn,
)

MODEL_NAME = "3dspeaker-campplus/1.0.0"


class DiarizationError(RuntimeError):
    """Raised when speaker feature extraction or clustering fails."""


@dataclass
class _Utterance:
    start_ms: int
    end_ms: int
    words: list[DiarizationWord]
    clip_start_ms: int = 0
    clip_end_ms: int = 0

    @property
    def text(self) -> str:
        return "".join(word.text for word in self.words).strip()


def diarize_audio(
    request: DiarizationRequest,
    *,
    ffmpeg_path: str,
    timeout_seconds: int,
) -> DiarizationResponse:
    started_at = time.monotonic()
    utterances = _group_words(request.words)
    if not utterances:
        return DiarizationResponse(
            analysis_id=request.analysis_id,
            model=MODEL_NAME,
            processing_seconds=round(time.monotonic() - started_at, 3),
            speaker_count=0,
            turns=[],
        )

    with tempfile.TemporaryDirectory(prefix="kid-audio-diarize-") as directory:
        clip_path = Path(directory) / "speech.wav"
        _extract_utterances(
            request.source_url,
            utterances,
            clip_path,
            ffmpeg_path=ffmpeg_path,
            timeout_seconds=timeout_seconds,
        )
        samples, sample_rate = _read_wave(clip_path)

    embeddings = [
        _speaker_embedding(
            samples[
                round(item.clip_start_ms * sample_rate / 1_000) :
                round(item.clip_end_ms * sample_rate / 1_000)
            ],
            sample_rate,
        )
        for item in utterances
    ]
    labels, confidences = _cluster_embeddings(
        embeddings,
        [item.end_ms - item.start_ms for item in utterances],
    )
    turns = _merge_turns(utterances, labels, confidences)
    return DiarizationResponse(
        analysis_id=request.analysis_id,
        model=MODEL_NAME,
        processing_seconds=round(time.monotonic() - started_at, 3),
        speaker_count=len(set(labels)),
        turns=turns,
    )


def _group_words(words: list[DiarizationWord]) -> list[_Utterance]:
    utterances: list[_Utterance] = []
    for word in sorted(words, key=lambda item: (item.start_ms, item.end_ms)):
        current = utterances[-1] if utterances else None
        should_split = (
            current is None
            or word.start_ms - current.end_ms
            > settings.diarization_utterance_gap_ms
            or word.end_ms - current.start_ms
            > settings.diarization_max_utterance_ms
        )
        if should_split:
            utterances.append(
                _Utterance(
                    start_ms=word.start_ms,
                    end_ms=word.end_ms,
                    words=[word],
                )
            )
        else:
            assert current is not None
            current.end_ms = max(current.end_ms, word.end_ms)
            current.words.append(word)
    return utterances


def _extract_utterances(
    source_url: str,
    utterances: list[_Utterance],
    output_path: Path,
    *,
    ffmpeg_path: str,
    timeout_seconds: int,
) -> None:
    command = [ffmpeg_path, "-nostdin", "-v", "error"]
    clip_cursor_ms = 0
    for utterance in utterances:
        extraction_start = max(0, utterance.start_ms - 150)
        extraction_end = utterance.end_ms + 150
        duration_ms = extraction_end - extraction_start
        utterance.clip_start_ms = clip_cursor_ms
        utterance.clip_end_ms = clip_cursor_ms + duration_ms
        clip_cursor_ms += duration_ms
        command.extend(
            [
                "-ss",
                f"{extraction_start / 1_000:.3f}",
                "-t",
                f"{duration_ms / 1_000:.3f}",
                "-i",
                source_url,
            ]
        )
    inputs = "".join(f"[{index}:a:0]" for index in range(len(utterances)))
    if len(utterances) == 1:
        command.extend(["-map", "0:a:0"])
    else:
        command.extend(
            [
                "-filter_complex",
                f"{inputs}concat=n={len(utterances)}:v=0:a=1[out]",
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
        raise DiarizationError("FFmpeg could not extract diarization utterances")


def _read_wave(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as audio:
        sample_rate = audio.getframerate()
        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2")
    return samples.astype(np.float32) / 32768.0, sample_rate


@lru_cache(maxsize=1)
def _embedding_session() -> ort.InferenceSession:
    model_path = Path(settings.diarization_model_path)
    if not model_path.is_file():
        raise DiarizationError(
            f"Speaker embedding model was not found at {model_path}"
        )
    return ort.InferenceSession(
        str(model_path),
        providers=["CPUExecutionProvider"],
    )


def _speaker_embedding(
    samples: np.ndarray,
    sample_rate: int,
) -> np.ndarray:
    if sample_rate != 16_000:
        raise DiarizationError("Speaker embeddings require 16 kHz audio")
    minimum_samples = round(sample_rate * 1.5)
    if samples.size == 0:
        samples = np.zeros(minimum_samples, dtype=np.float32)
    elif samples.size < minimum_samples:
        samples = np.tile(
            samples,
            int(np.ceil(minimum_samples / samples.size)),
        )[:minimum_samples]

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
        raise DiarizationError("Could not extract speaker features")
    features = np.asarray(
        [extractor.get_frame(index) for index in range(frame_count)],
        dtype=np.float32,
    )
    features -= np.mean(features, axis=0, keepdims=True)
    output = _embedding_session().run(
        None,
        {"x": features[np.newaxis, :, :]},
    )
    embedding = cast(np.ndarray, output[0])[0].astype(np.float32)
    norm = float(np.linalg.norm(embedding))
    if norm <= 0:
        raise DiarizationError("Speaker model returned an empty embedding")
    return np.asarray(embedding / norm, dtype=np.float32)


def _cluster_embeddings(
    embeddings: list[np.ndarray],
    durations_ms: list[int],
) -> tuple[list[int], list[float]]:
    if not embeddings:
        return [], []
    anchor_indices = [
        index
        for index, duration_ms in enumerate(durations_ms)
        if duration_ms >= settings.diarization_min_anchor_ms
    ]
    if not anchor_indices:
        anchor_indices = list(range(len(embeddings)))
    clusters = [[index] for index in anchor_indices]

    while len(clusters) > 1:
        best_pair: tuple[int, int] | None = None
        best_similarity = -1.0
        for left_index in range(len(clusters)):
            for right_index in range(left_index + 1, len(clusters)):
                similarity = _cluster_similarity(
                    clusters[left_index],
                    clusters[right_index],
                    embeddings,
                )
                if similarity > best_similarity:
                    best_similarity = similarity
                    best_pair = (left_index, right_index)
        must_reduce = len(clusters) > settings.diarization_max_speakers
        if (
            best_pair is None
            or (
                not must_reduce
                and best_similarity
                < settings.diarization_similarity_threshold
            )
        ):
            break
        left_index, right_index = best_pair
        clusters[left_index].extend(clusters[right_index])
        del clusters[right_index]

    centroids = [_cluster_centroid(cluster, embeddings) for cluster in clusters]
    labels = [0] * len(embeddings)
    confidences = [0.0] * len(embeddings)
    for index, embedding in enumerate(embeddings):
        similarities = [
            float(np.dot(embedding, centroid)) for centroid in centroids
        ]
        label = int(np.argmax(similarities))
        labels[index] = label
        confidences[index] = max(0.0, min(1.0, similarities[label]))

    first_occurrence = {
        label: min(
            index for index, item_label in enumerate(labels)
            if item_label == label
        )
        for label in set(labels)
    }
    label_order = {
        old_label: new_label
        for new_label, old_label in enumerate(
            sorted(
                first_occurrence,
                key=lambda label: first_occurrence[label],
            )
        )
    }
    labels = [label_order[label] for label in labels]
    return labels, confidences


def _cluster_centroid(
    indices: list[int],
    embeddings: list[np.ndarray],
) -> np.ndarray:
    centroid = np.mean([embeddings[index] for index in indices], axis=0)
    norm = float(np.linalg.norm(centroid))
    return centroid / norm if norm > 0 else centroid


def _cluster_similarity(
    left: list[int],
    right: list[int],
    embeddings: list[np.ndarray],
) -> float:
    return float(
        np.dot(
            _cluster_centroid(left, embeddings),
            _cluster_centroid(right, embeddings),
        )
    )


def _merge_turns(
    utterances: list[_Utterance],
    labels: list[int],
    confidences: list[float],
) -> list[SpeakerTurn]:
    turns: list[SpeakerTurn] = []
    for utterance, label, confidence in zip(
        utterances, labels, confidences, strict=True
    ):
        speaker_id = f"SPEAKER_{label + 1:02d}"
        current = turns[-1] if turns else None
        if (
            current
            and current.speaker_id == speaker_id
            and utterance.start_ms - current.end_ms <= 1_000
        ):
            current.end_ms = utterance.end_ms
            current.text = f"{current.text} {utterance.text}".strip()
            current.confidence = min(current.confidence, confidence)
        else:
            turns.append(
                SpeakerTurn(
                    start_ms=utterance.start_ms,
                    end_ms=utterance.end_ms,
                    speaker_id=speaker_id,
                    text=utterance.text,
                    confidence=round(confidence, 4),
                )
            )
    return turns
