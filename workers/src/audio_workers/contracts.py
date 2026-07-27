from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )


class ScanRequest(ApiModel):
    analysis_id: str = Field(min_length=1, max_length=128)
    source_url: str = Field(min_length=1, max_length=8192)
    sample_rate: int = Field(default=16_000)
    frame_ms: int = Field(default=30)
    window_ms: int = Field(default=30_000, ge=1_000, le=120_000)
    overlap_ms: int = Field(default=2_000, ge=0, le=30_000)
    vad_mode: int = Field(default=2, ge=0, le=3)

    @model_validator(mode="after")
    def validate_window(self) -> "ScanRequest":
        if self.sample_rate not in {8_000, 16_000, 32_000, 48_000}:
            raise ValueError("sampleRate must be supported by WebRTC VAD")
        if self.frame_ms not in {10, 20, 30}:
            raise ValueError("frameMs must be 10, 20, or 30 for WebRTC VAD")
        if self.window_ms <= self.overlap_ms:
            raise ValueError("windowMs must be greater than overlapMs")
        if self.window_ms < self.frame_ms:
            raise ValueError("windowMs must be at least frameMs")
        return self


class ScanWindow(ApiModel):
    start_ms: int
    end_ms: int
    speech_ratio: float
    rms_dbfs: float
    peak_dbfs: float
    labels: list[str]


class SpeechInterval(ApiModel):
    start_ms: int
    end_ms: int
    confidence: float


class ScanSummary(ApiModel):
    decoded_duration_ms: int
    processing_seconds: float
    speech_duration_ms: int
    speech_ratio: float
    window_count: int
    speech_interval_count: int


class ScanResponse(ApiModel):
    analysis_id: str
    pipeline_version: str
    capabilities: list[str]
    sample_rate: int
    vad_mode: int
    windows: list[ScanWindow]
    speech_intervals: list[SpeechInterval]
    summary: ScanSummary


class TranscriptionRange(ApiModel):
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)


class TranscriptionRequest(ApiModel):
    analysis_id: str = Field(min_length=1, max_length=128)
    chunk_id: str = Field(min_length=1, max_length=128)
    source_url: str = Field(min_length=1, max_length=8192)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    ranges: list[TranscriptionRange] = Field(min_length=1)
    language_mode: Literal["AUTO", "ENGLISH", "HINDI_HINGLISH"] = "AUTO"

    @model_validator(mode="after")
    def validate_range(self) -> "TranscriptionRequest":
        if self.end_ms <= self.start_ms:
            raise ValueError("endMs must be greater than startMs")
        if any(item.end_ms <= item.start_ms for item in self.ranges):
            raise ValueError("every transcription range must have positive duration")
        duration_ms = sum(item.end_ms - item.start_ms for item in self.ranges)
        if duration_ms > 120_000:
            raise ValueError("selected transcription audio must not exceed 120 seconds")
        if self.start_ms != self.ranges[0].start_ms:
            raise ValueError("startMs must match the first selected range")
        if self.end_ms != self.ranges[-1].end_ms:
            raise ValueError("endMs must match the last selected range")
        return self


class TranscriptWord(ApiModel):
    start_ms: int
    end_ms: int
    text: str
    probability: float | None = None


class TranscriptionResponse(ApiModel):
    analysis_id: str
    chunk_id: str
    model: str
    language: str | None = None
    language_probability: float | None = None
    processing_seconds: float
    extraction_seconds: float
    inference_seconds: float
    audio_duration_seconds: float
    audio_duration_after_vad_seconds: float | None = None
    vad_fallback_used: bool = False
    quality_retry_used: bool = False
    language_mode: Literal["AUTO", "ENGLISH", "HINDI_HINGLISH"] = "AUTO"
    text: str
    words: list[TranscriptWord]


class DiarizationWord(ApiModel):
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    text: str = Field(min_length=1)


class DiarizationRequest(ApiModel):
    analysis_id: str = Field(min_length=1, max_length=128)
    source_url: str = Field(min_length=1, max_length=8192)
    words: list[DiarizationWord]

    @model_validator(mode="after")
    def validate_words(self) -> "DiarizationRequest":
        if any(word.end_ms <= word.start_ms for word in self.words):
            raise ValueError("every diarization word must have positive duration")
        return self


class SpeakerTurn(ApiModel):
    start_ms: int
    end_ms: int
    speaker_id: str
    text: str
    confidence: float


class DiarizationResponse(ApiModel):
    analysis_id: str
    model: str
    processing_seconds: float
    speaker_count: int
    turns: list[SpeakerTurn]


class ContextUtterance(ApiModel):
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    speaker_id: str = Field(min_length=1)
    text: str
    confidence: float | None = Field(default=None, ge=0, le=1)


class ContextSession(ApiModel):
    session_id: str = Field(min_length=1)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    speakers: list[str]
    utterances: list[ContextUtterance]


class ContextClassificationRequest(ApiModel):
    analysis_id: str = Field(min_length=1, max_length=128)
    sessions: list[ContextSession]


class QualityAssessment(ApiModel):
    score: float
    usable: bool
    flags: list[str]
    cleaned_text: str


class ClassificationLabel(ApiModel):
    label: str
    confidence: float


class ProfanityOccurrence(ApiModel):
    canonical_term: str
    confidence: float
    end_ms: int
    evidence: str
    severity: str
    speaker_id: str
    start_ms: int
    term: str


class ProfanityAssessment(ApiModel):
    severity: str
    terms: list[str]
    directed_at_child: str = "unknown"
    occurrence_count: int = 0
    occurrences: list[ProfanityOccurrence] = Field(default_factory=list)
    exposure_level: str = "none"
    notification_recommended: bool = False
    notification_reason: str | None = None


class SafetySignal(ApiModel):
    signal_type: str
    severity: str
    confidence: float
    start_ms: int
    end_ms: int
    speaker_id: str
    evidence: str


class ContextSessionResult(ApiModel):
    session_id: str
    quality: QualityAssessment
    conversation_type: ClassificationLabel
    profanity: ProfanityAssessment
    safety_signals: list[SafetySignal]


class ContextClassificationResponse(ApiModel):
    analysis_id: str
    model: str
    processing_seconds: float
    sessions: list[ContextSessionResult]


class AcousticRange(ApiModel):
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)


class AcousticDetectionRequest(ApiModel):
    analysis_id: str = Field(min_length=1, max_length=128)
    chunk_id: str = Field(min_length=1, max_length=128)
    source_url: str = Field(min_length=1, max_length=8192)
    ranges: list[AcousticRange] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_ranges(self) -> "AcousticDetectionRequest":
        if any(item.end_ms <= item.start_ms for item in self.ranges):
            raise ValueError("every acoustic range must have positive duration")
        duration_ms = sum(item.end_ms - item.start_ms for item in self.ranges)
        if duration_ms > 120_000:
            raise ValueError("selected acoustic audio must not exceed 120 seconds")
        return self


class AcousticEvent(ApiModel):
    start_ms: int
    end_ms: int
    label: str
    category: str
    severity: str
    confidence: float


class AcousticDetectionResponse(ApiModel):
    analysis_id: str
    chunk_id: str
    model: str
    processing_seconds: float
    window_count: int
    events: list[AcousticEvent]
