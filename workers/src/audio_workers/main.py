import logging
from datetime import UTC, datetime
from typing import Literal

from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import HTTPException
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


@app.post("/v1/scan", response_model=ScanResponse, tags=["inference"])
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
