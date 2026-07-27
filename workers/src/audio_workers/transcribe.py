import math
import tempfile
import threading
import time
import wave
from functools import lru_cache
from pathlib import Path
from typing import Any, NamedTuple

from faster_whisper import (  # type: ignore[import-untyped]
    BatchedInferencePipeline,
    WhisperModel,
)

from audio_workers.audio_cache import AudioCacheError, ensure_normalized_audio
from audio_workers.config import settings
from audio_workers.contracts import (
    TranscriptionRequest,
    TranscriptionResponse,
    TranscriptWord,
)


class TranscriptionError(RuntimeError):
    """Raised when range extraction or speech recognition fails."""


class DecodeCandidate(NamedTuple):
    words: list[TranscriptWord]
    info: Any
    audio_duration_after_vad: float | None


_asr_thread_local = threading.local()


@lru_cache(maxsize=1)
def get_asr_model() -> WhisperModel:
    return WhisperModel(
        settings.asr_model_size,
        device=settings.asr_device,
        compute_type=settings.asr_compute_type,
        cpu_threads=settings.asr_cpu_threads,
        num_workers=settings.asr_num_workers,
    )


def get_batched_asr_model() -> BatchedInferencePipeline:
    existing = getattr(_asr_thread_local, "batched_model", None)
    if existing is None:
        existing = BatchedInferencePipeline(model=get_asr_model())
        _asr_thread_local.batched_model = existing
    return existing


def transcribe_audio(
    request: TranscriptionRequest,
    *,
    ffmpeg_path: str,
    timeout_seconds: int,
    model: WhisperModel | None = None,
    normalized_source: Path | None = None,
) -> TranscriptionResponse:
    started_at = time.monotonic()
    extraction_started_at = time.monotonic()
    try:
        source_path = normalized_source or ensure_normalized_audio(
            request.analysis_id,
            request.source_url,
            ffmpeg_path=ffmpeg_path,
            timeout_seconds=timeout_seconds,
        )
    except AudioCacheError as error:
        raise TranscriptionError(str(error)) from error

    with tempfile.TemporaryDirectory(prefix="kid-audio-asr-") as directory:
        clip_path = Path(directory) / "clip.wav"
        _assemble_ranges(source_path, clip_path, request)
        extraction_seconds = time.monotonic() - extraction_started_at

        selected_model: Any
        if model is not None:
            selected_model = model
        elif settings.asr_batch_size > 1:
            selected_model = get_batched_asr_model()
        else:
            selected_model = get_asr_model()

        inference_started_at = time.monotonic()
        options: dict[str, object] = {
            "task": "transcribe",
            "beam_size": settings.asr_beam_size,
            "word_timestamps": True,
            "vad_filter": settings.asr_vad_filter,
            "vad_parameters": {
                "threshold": settings.asr_vad_threshold,
                "min_silence_duration_ms": settings.asr_vad_min_silence_ms,
                "speech_pad_ms": settings.asr_vad_speech_pad_ms,
            },
            "condition_on_previous_text": True,
            "multilingual": True,
            "hallucination_silence_threshold": 2.0,
        }
        options.update(_language_options(request.language_mode))
        if model is None and settings.asr_batch_size > 1:
            options["batch_size"] = settings.asr_batch_size
        audio_duration_seconds = sum(
            item.end_ms - item.start_ms for item in request.ranges
        ) / 1_000
        candidate = _decode_candidate(
            selected_model,
            clip_path,
            request,
            options,
        )
        audio_duration_after_vad = candidate.audio_duration_after_vad
        vad_fallback_used = bool(
            settings.asr_vad_filter
            and audio_duration_after_vad is not None
            and audio_duration_seconds > 0
            and audio_duration_after_vad / audio_duration_seconds
            < settings.asr_vad_fallback_ratio
        )
        if vad_fallback_used:
            fallback_options = {**options, "vad_filter": False}
            fallback_options.pop("vad_parameters", None)
            if model is None and settings.asr_batch_size > 1:
                fallback_options["clip_timestamps"] = [
                    {
                        "start": float(start),
                        "end": float(min(start + 30, audio_duration_seconds)),
                    }
                    for start in range(
                        0, max(1, math.ceil(audio_duration_seconds)), 30
                    )
                ]
            candidate = _decode_candidate(
                selected_model,
                clip_path,
                request,
                fallback_options,
            )
            audio_duration_after_vad = candidate.audio_duration_after_vad
            options = fallback_options

        quality_retry_used = False
        retry_modes = _retry_modes(request.language_mode)
        if (
            retry_modes
            and _is_suspicious(candidate, request.language_mode)
        ):
            retry_candidates = [
                _decode_candidate(
                    selected_model,
                    clip_path,
                    request,
                    {
                        **options,
                        **_language_options(retry_mode),
                        "condition_on_previous_text": False,
                    },
                )
                for retry_mode in retry_modes
            ]
            candidate = max(
                [candidate, *retry_candidates],
                key=lambda item: _candidate_score(
                    item, request.language_mode
                ),
            )
            audio_duration_after_vad = candidate.audio_duration_after_vad
            quality_retry_used = True

        words = candidate.words
        if _is_repetitive_hallucination(words):
            words = []
        inference_seconds = time.monotonic() - inference_started_at

    return TranscriptionResponse(
        analysis_id=request.analysis_id,
        chunk_id=request.chunk_id,
        model=settings.asr_model_size,
        language=candidate.info.language,
        language_probability=candidate.info.language_probability,
        processing_seconds=round(time.monotonic() - started_at, 3),
        extraction_seconds=round(extraction_seconds, 3),
        inference_seconds=round(inference_seconds, 3),
        audio_duration_seconds=round(audio_duration_seconds, 3),
        audio_duration_after_vad_seconds=audio_duration_after_vad,
        vad_fallback_used=vad_fallback_used,
        quality_retry_used=quality_retry_used,
        language_mode=request.language_mode,
        text="".join(word.text for word in words).strip(),
        words=words,
    )


def _language_options(language_mode: str) -> dict[str, object]:
    if language_mode == "ENGLISH":
        return {"language": "en", "multilingual": False}
    if language_mode == "HINDI_HINGLISH":
        return {"language": "hi", "multilingual": True}
    return {
        "language": None,
        "multilingual": True,
        "language_detection_segments": 3,
        "language_detection_threshold": (
            settings.asr_language_probability_threshold
        ),
    }


def _retry_modes(language_mode: str) -> list[str]:
    if language_mode == "AUTO":
        return ["HINDI_HINGLISH", "ENGLISH"]
    if language_mode == "HINDI_HINGLISH":
        return ["AUTO", "ENGLISH"]
    return []


def _decode_candidate(
    selected_model: Any,
    clip_path: Path,
    request: TranscriptionRequest,
    options: dict[str, object],
) -> DecodeCandidate:
    segments, info = selected_model.transcribe(str(clip_path), **options)
    words: list[TranscriptWord] = []
    for segment in segments:
        for word in segment.words or []:
            probability = getattr(word, "probability", None)
            if (
                probability is not None
                and probability < settings.asr_min_word_probability
            ):
                continue
            words.append(
                TranscriptWord(
                    start_ms=map_clip_time_to_source(
                        request, round(word.start * 1_000)
                    ),
                    end_ms=map_clip_time_to_source(
                        request, round(word.end * 1_000), is_end=True
                    ),
                    text=word.word,
                    probability=probability,
                )
            )
    return DecodeCandidate(
        words=words,
        info=info,
        audio_duration_after_vad=getattr(
            info, "duration_after_vad", None
        ),
    )


def _is_suspicious(
    candidate: DecodeCandidate,
    language_mode: str,
) -> bool:
    words = candidate.words
    if _is_repetitive_hallucination(words):
        return True
    if not words:
        return bool(
            candidate.audio_duration_after_vad is None
            or candidate.audio_duration_after_vad >= 2
        )
    language = getattr(candidate.info, "language", None)
    probability = getattr(candidate.info, "language_probability", 0.0)
    if language_mode == "AUTO" and language not in {"en", "hi"}:
        return True
    if probability < settings.asr_language_probability_threshold:
        return True
    text = "".join(word.text for word in words)
    if _unexpected_script_ratio(text) > 0.1:
        return True
    zero_duration = sum(
        word.end_ms <= word.start_ms for word in words
    ) / len(words)
    return zero_duration > 0.3


def _candidate_score(
    candidate: DecodeCandidate,
    language_mode: str,
) -> float:
    if not candidate.words:
        return -10.0
    probabilities = [
        word.probability
        for word in candidate.words
        if word.probability is not None
    ]
    confidence = (
        sum(probabilities) / len(probabilities)
        if probabilities
        else 0.0
    )
    text = "".join(word.text for word in candidate.words)
    score = confidence + min(len(candidate.words), 20) * 0.01
    score -= _unexpected_script_ratio(text) * 4
    if _is_repetitive_hallucination(candidate.words):
        score -= 5
    zero_duration = sum(
        word.end_ms <= word.start_ms for word in candidate.words
    ) / len(candidate.words)
    score -= zero_duration * 2
    language = getattr(candidate.info, "language", None)
    if language_mode == "ENGLISH" and language == "en":
        score += 0.25
    if language_mode == "HINDI_HINGLISH" and language == "hi":
        score += 0.25
    if language_mode == "AUTO" and language in {"en", "hi"}:
        score += 0.15
    return score


def _unexpected_script_ratio(text: str) -> float:
    letters = [character for character in text if character.isalpha()]
    if not letters:
        return 0.0
    unexpected = sum(
        not (
            "a" <= character.casefold() <= "z"
            or "\u0900" <= character <= "\u097f"
        )
        for character in letters
    )
    return unexpected / len(letters)


def _is_repetitive_hallucination(words: list[TranscriptWord]) -> bool:
    if len(words) < 10:
        return False
    normalized = [word.text.strip().casefold() for word in words]
    counts = {
        token: normalized.count(token)
        for token in set(normalized)
        if token
    }
    return bool(
        counts
        and max(counts.values()) / len(normalized) >= 0.7
    )


def _assemble_ranges(
    source_path: Path,
    output_path: Path,
    request: TranscriptionRequest,
) -> None:
    try:
        with wave.open(str(source_path), "rb") as source:
            sample_rate = source.getframerate()
            if (
                source.getnchannels() != 1
                or source.getsampwidth() != 2
                or sample_rate != 16_000
            ):
                raise TranscriptionError(
                    "Cached ASR audio must be mono 16 kHz PCM"
                )
            with wave.open(str(output_path), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(sample_rate)
                for selected_range in request.ranges:
                    start_frame = round(
                        selected_range.start_ms * sample_rate / 1_000
                    )
                    frame_count = round(
                        (selected_range.end_ms - selected_range.start_ms)
                        * sample_rate
                        / 1_000
                    )
                    source.setpos(min(start_frame, source.getnframes()))
                    output.writeframesraw(source.readframes(frame_count))
    except (EOFError, wave.Error) as error:
        raise TranscriptionError(
            "Could not assemble cached ASR ranges"
        ) from error


def map_clip_time_to_source(
    request: TranscriptionRequest,
    clip_time_ms: int,
    *,
    is_end: bool = False,
) -> int:
    elapsed_ms = 0
    for selected_range in request.ranges:
        duration_ms = selected_range.end_ms - selected_range.start_ms
        boundary_matches = (
            clip_time_ms <= elapsed_ms + duration_ms
            if is_end
            else clip_time_ms < elapsed_ms + duration_ms
        )
        if boundary_matches:
            return selected_range.start_ms + max(0, clip_time_ms - elapsed_ms)
        elapsed_ms += duration_ms
    return request.ranges[-1].end_ms
