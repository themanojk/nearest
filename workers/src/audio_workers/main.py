import hmac
import logging
import os
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, Response, status
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import HTTPException
from faster_whisper.utils import download_model  # type: ignore[import-untyped]
from pydantic import BaseModel

from audio_workers.acoustic import (
    AcousticDetectionError,
    detect_acoustic_events,
)
from audio_workers.config import settings
from audio_workers.context import classify_context
from audio_workers.contracts import (
    AcousticDetectionRequest,
    AcousticDetectionResponse,
    ContextClassificationRequest,
    ContextClassificationResponse,
    DiarizationRequest,
    DiarizationResponse,
    ScanRequest,
    ScanResponse,
    TranscriptionRequest,
    TranscriptionResponse,
)
from audio_workers.diarize import DiarizationError, diarize_audio
from audio_workers.lexicon import LexiconError, load_hotwords
from audio_workers.scan import AudioScanError, scan_audio, validate_source_url
from audio_workers.transcribe import (
    TranscriptionError,
    transcribe_audio,
)

logger = logging.getLogger("audio_workers")


class HealthResponse(BaseModel):
    service: str
    version: str
    status: Literal["ok"]
    timestamp: datetime


class ReadinessResponse(BaseModel):
    service: str
    version: str
    status: Literal["ready", "not_ready"]
    checks: dict[str, bool]
    timestamp: datetime


def require_worker_token(authorization: str | None = Header(default=None)) -> None:
    if not settings.api_token:
        return
    expected = f"Bearer {settings.api_token}"
    if authorization is None or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Invalid worker credentials")


INFERENCE_DEPENDENCIES = [Depends(require_worker_token)]


app = FastAPI(
    title="Kid Audio Intelligence Workers",
    description="Internal inference service for audio-processing workloads.",
    version=settings.service_version,
)


@app.get("/health", response_model=HealthResponse, tags=["operations"])
async def health() -> HealthResponse:
    return HealthResponse(
        service=settings.service_name,
        version=settings.service_version,
        status="ok",
        timestamp=datetime.now(UTC),
    )


@app.get("/ready", response_model=ReadinessResponse, tags=["operations"])
async def readiness(response: Response) -> ReadinessResponse:
    ffmpeg = Path(settings.ffmpeg_path)
    ffmpeg_available = (
        ffmpeg.is_file() and os.access(ffmpeg, os.X_OK)
        if ffmpeg.parent != Path(".")
        else shutil.which(settings.ffmpeg_path) is not None
    )
    checks = {
        "ffmpeg": ffmpeg_available,
        "asr_model": _asr_model_available(),
        "asr_hotword_lexicon": _hotword_lexicon_available(),
        "diarization_model": Path(settings.diarization_model_path).is_file(),
        "acoustic_model": Path(settings.acoustic_model_path).is_file(),
        "acoustic_labels": Path(settings.acoustic_labels_path).is_file(),
        "audio_cache": _cache_is_writable(),
    }
    ready = all(checks.values())
    if not ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadinessResponse(
        service=settings.service_name,
        version=settings.service_version,
        status="ready" if ready else "not_ready",
        checks=checks,
        timestamp=datetime.now(UTC),
    )


def _cache_is_writable() -> bool:
    try:
        cache_dir = Path(settings.asr_cache_dir)
        cache_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=cache_dir):
            return True
    except OSError:
        return False


def _asr_model_available() -> bool:
    configured_path = Path(settings.asr_model_size)
    if configured_path.is_dir():
        return True
    try:
        download_model(settings.asr_model_size, local_files_only=True)
        return True
    except Exception:
        return False


def _hotword_lexicon_available() -> bool:
    try:
        load_hotwords(settings.asr_hotwords_path)
        return True
    except LexiconError:
        return False


@app.post(
    "/v1/scan",
    response_model=ScanResponse,
    tags=["inference"],
    dependencies=INFERENCE_DEPENDENCIES,
)
async def scan(request: ScanRequest) -> ScanResponse:
    try:
        logger.info("scan.started analysis_id=%s", request.analysis_id)
        validate_source_url(request.source_url, settings.audio_host_allowlist)
        result = await run_in_threadpool(
            scan_audio,
            request,
            ffmpeg_path=settings.ffmpeg_path,
            timeout_seconds=settings.ffmpeg_timeout_seconds,
        )
        logger.info(
            "scan.completed analysis_id=%s windows=%s speech_intervals=%s "
            "speech_ratio=%s",
            request.analysis_id,
            result.summary.window_count,
            result.summary.speech_interval_count,
            result.summary.speech_ratio,
        )
        return result
    except AudioScanError as error:
        logger.warning(
            "scan.failed analysis_id=%s reason=%s",
            request.analysis_id,
            str(error),
        )
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post(
    "/v1/transcribe",
    response_model=TranscriptionResponse,
    tags=["inference"],
    dependencies=INFERENCE_DEPENDENCIES,
)
async def transcribe(request: TranscriptionRequest) -> TranscriptionResponse:
    try:
        logger.info(
            "transcription.started analysis_id=%s chunk_id=%s start_ms=%s "
            "end_ms=%s language_mode=%s",
            request.analysis_id,
            request.chunk_id,
            request.start_ms,
            request.end_ms,
            request.language_mode,
        )
        validate_source_url(request.source_url, settings.audio_host_allowlist)
        result = await run_in_threadpool(
            transcribe_audio,
            request,
            ffmpeg_path=settings.ffmpeg_path,
            timeout_seconds=settings.ffmpeg_timeout_seconds,
        )
        logger.info(
            "transcription.completed analysis_id=%s chunk_id=%s words=%s "
            "language=%s processing_seconds=%s extraction_seconds=%s "
            "inference_seconds=%s audio_after_vad_seconds=%s "
            "vad_fallback_used=%s quality_retry_used=%s",
            request.analysis_id,
            request.chunk_id,
            len(result.words),
            result.language,
            result.processing_seconds,
            result.extraction_seconds,
            result.inference_seconds,
            result.audio_duration_after_vad_seconds,
            result.vad_fallback_used,
            result.quality_retry_used,
        )
        return result
    except (AudioScanError, TranscriptionError) as error:
        logger.warning(
            "transcription.failed analysis_id=%s chunk_id=%s reason=%s",
            request.analysis_id,
            request.chunk_id,
            str(error),
        )
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post(
    "/v1/diarize",
    response_model=DiarizationResponse,
    tags=["inference"],
    dependencies=INFERENCE_DEPENDENCIES,
)
async def diarize(request: DiarizationRequest) -> DiarizationResponse:
    try:
        logger.info(
            "diarization.started analysis_id=%s words=%s",
            request.analysis_id,
            len(request.words),
        )
        validate_source_url(request.source_url, settings.audio_host_allowlist)
        result = await run_in_threadpool(
            diarize_audio,
            request,
            ffmpeg_path=settings.ffmpeg_path,
            timeout_seconds=settings.ffmpeg_timeout_seconds,
        )
        logger.info(
            "diarization.completed analysis_id=%s speakers=%s turns=%s "
            "processing_seconds=%s",
            request.analysis_id,
            result.speaker_count,
            len(result.turns),
            result.processing_seconds,
        )
        return result
    except (AudioScanError, DiarizationError) as error:
        logger.warning(
            "diarization.failed analysis_id=%s reason=%s",
            request.analysis_id,
            str(error),
        )
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post(
    "/v1/classify-context",
    response_model=ContextClassificationResponse,
    tags=["inference"],
    dependencies=INFERENCE_DEPENDENCIES,
)
async def classify_conversation_context(
    request: ContextClassificationRequest,
) -> ContextClassificationResponse:
    logger.info(
        "context.started analysis_id=%s sessions=%s",
        request.analysis_id,
        len(request.sessions),
    )
    result = await run_in_threadpool(classify_context, request)
    logger.info(
        "context.completed analysis_id=%s sessions=%s processing_seconds=%s",
        request.analysis_id,
        len(result.sessions),
        result.processing_seconds,
    )
    return result


@app.post(
    "/v1/detect-acoustic-events",
    response_model=AcousticDetectionResponse,
    tags=["inference"],
    dependencies=INFERENCE_DEPENDENCIES,
)
async def detect_events(
    request: AcousticDetectionRequest,
) -> AcousticDetectionResponse:
    try:
        logger.info(
            "acoustic.started analysis_id=%s chunk_id=%s ranges=%s",
            request.analysis_id,
            request.chunk_id,
            len(request.ranges),
        )
        validate_source_url(request.source_url, settings.audio_host_allowlist)
        result = await run_in_threadpool(
            detect_acoustic_events,
            request,
            ffmpeg_path=settings.ffmpeg_path,
            timeout_seconds=settings.ffmpeg_timeout_seconds,
        )
        logger.info(
            "acoustic.completed analysis_id=%s chunk_id=%s windows=%s "
            "events=%s processing_seconds=%s",
            request.analysis_id,
            request.chunk_id,
            result.window_count,
            len(result.events),
            result.processing_seconds,
        )
        return result
    except (AudioScanError, AcousticDetectionError) as error:
        logger.warning(
            "acoustic.failed analysis_id=%s chunk_id=%s reason=%s",
            request.analysis_id,
            request.chunk_id,
            str(error),
        )
        raise HTTPException(status_code=422, detail=str(error)) from error
