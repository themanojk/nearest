import {
  AnalysisStatus,
  MediaMetadata,
  PipelineStageProgress,
  TranscriptionLanguageMode,
} from './schemas/analysis-job.schema';
import { ScanSegmentType } from './schemas/scan-segment.schema';
import {
  TranscriptWord,
  TranscriptionChunkStatus,
} from './schemas/transcription-chunk.schema';

export interface IngestAudioJob {
  analysisId: string;
  contentType: string;
  objectKey: string;
  sizeBytes: number;
  tenantId: string;
}

export interface AnalysisResponse {
  acousticStage: PipelineStageProgress;
  acousticSummary?: AcousticSummary;
  riskStage: PipelineStageProgress;
  riskSummary?: RiskSummary;
  analysisId: string;
  childId: string;
  conversationStage: PipelineStageProgress;
  conversationSummary?: ConversationSummary;
  contextStage: PipelineStageProgress;
  contextSummary?: ContextSummary;
  contentType: string;
  createdAt: Date;
  fileName: string;
  diarizationStage: PipelineStageProgress;
  diarizationSummary?: DiarizationSummary;
  ingestStage: PipelineStageProgress;
  mediaMetadata?: MediaMetadata;
  scanStage: PipelineStageProgress;
  scanSummary?: ScanSummary;
  transcriptionStage: PipelineStageProgress;
  transcriptionLanguageMode: TranscriptionLanguageMode;
  transcriptionSummary?: TranscriptionSummary;
  progress: number;
  sizeBytes: number;
  status: AnalysisStatus;
  updatedAt: Date;
}

export interface AnalysisPageResponse {
  items: AnalysisResponse[];
  limit: number;
  page: number;
  total: number;
}

export interface AudioPlaybackResponse {
  contentType: string;
  expiresAt: Date;
  fileName: string;
  url: string;
}

export interface DiarizeAudioJob {
  analysisId: string;
  objectKey: string;
  tenantId: string;
}

export interface ClassifyContextJob {
  analysisId: string;
  tenantId: string;
}

export interface DetectAcousticEventsJob {
  analysisId: string;
  objectKey: string;
  tenantId: string;
}

export interface AggregateRiskJob {
  analysisId: string;
  tenantId: string;
}

export interface ScanAudioJob {
  analysisId: string;
  objectKey: string;
  tenantId: string;
}

export interface TranscribeAudioJob {
  analysisId: string;
  chunkId: string;
  endMs: number;
  objectKey: string;
  ranges: Array<{ endMs: number; startMs: number }>;
  startMs: number;
  tenantId: string;
  transcriptionLanguageMode: TranscriptionLanguageMode;
}

export interface ScanWindowResult {
  endMs: number;
  labels: string[];
  peakDbfs: number;
  rmsDbfs: number;
  speechRatio: number;
  startMs: number;
}

export interface SpeechIntervalResult {
  confidence: number;
  endMs: number;
  startMs: number;
}

export interface ScanSummary {
  decodedDurationMs: number;
  processingRegionCount: number;
  pipelineVersion: string;
  processingSeconds: number;
  removedSilenceDurationMs: number;
  retainedDurationMs: number;
  retainedRatio: number;
  speechDurationMs: number;
  speechIntervalCount: number;
  speechRatio: number;
  windowCount: number;
}

export interface WorkerScanResponse {
  analysisId: string;
  capabilities: string[];
  pipelineVersion: string;
  sampleRate: number;
  speechIntervals: SpeechIntervalResult[];
  summary: Omit<
    ScanSummary,
    | 'pipelineVersion'
    | 'processingRegionCount'
    | 'removedSilenceDurationMs'
    | 'retainedDurationMs'
    | 'retainedRatio'
  >;
  vadMode: number;
  windows: ScanWindowResult[];
}

export interface WorkerTranscriptWord {
  endMs: number;
  probability?: number;
  startMs: number;
  text: string;
}

export interface WorkerTranscriptionResponse {
  audioDurationAfterVadSeconds?: number;
  audioDurationSeconds: number;
  analysisId: string;
  chunkId: string;
  extractionSeconds: number;
  inferenceSeconds: number;
  language?: string;
  languageMode: TranscriptionLanguageMode;
  languageProbability?: number;
  model: string;
  processingSeconds: number;
  qualityRetryUsed: boolean;
  text: string;
  vadFallbackUsed: boolean;
  words: WorkerTranscriptWord[];
}

export interface WorkerSpeakerTurn {
  confidence: number;
  endMs: number;
  speakerId: string;
  startMs: number;
  text: string;
}

export interface WorkerDiarizationResponse {
  analysisId: string;
  model: string;
  processingSeconds: number;
  speakerCount: number;
  turns: WorkerSpeakerTurn[];
}

export interface DiarizationSummary {
  model: string;
  processingSeconds: number;
  speakerCount: number;
  turnCount: number;
}

export interface ConversationSummary {
  sessionCount: number;
  utteranceCount: number;
}

export interface ContextSummary {
  flaggedSessionCount: number;
  highSeverityCount: number;
  model: string;
  processingSeconds: number;
  profanityNotificationCount: number;
  profanityOccurrenceCount: number;
  profanitySessionCount: number;
  safetySignalCount: number;
  sessionCount: number;
  usableSessionCount: number;
}

export interface WorkerQualityAssessment {
  cleanedText: string;
  flags: string[];
  score: number;
  usable: boolean;
}

export interface WorkerSafetySignal {
  confidence: number;
  endMs: number;
  evidence: string;
  severity: string;
  signalType: string;
  speakerId: string;
  startMs: number;
}

export interface WorkerContextSessionResult {
  conversationType: {
    confidence: number;
    label: string;
  };
  profanity: {
    directedAtChild: 'unknown';
    exposureLevel: string;
    notificationReason?: string;
    notificationRecommended: boolean;
    occurrenceCount: number;
    occurrences: Array<{
      canonicalTerm: string;
      confidence: number;
      endMs: number;
      evidence: string;
      severity: string;
      speakerId: string;
      startMs: number;
      term: string;
    }>;
    severity: string;
    terms: string[];
  };
  quality: WorkerQualityAssessment;
  safetySignals: WorkerSafetySignal[];
  sessionId: string;
}

export interface WorkerContextClassificationResponse {
  analysisId: string;
  model: string;
  processingSeconds: number;
  sessions: WorkerContextSessionResult[];
}

export interface WorkerAcousticEvent {
  category: string;
  confidence: number;
  endMs: number;
  label: string;
  severity: string;
  startMs: number;
}

export interface WorkerAcousticDetectionResponse {
  analysisId: string;
  chunkId: string;
  events: WorkerAcousticEvent[];
  model: string;
  processingSeconds: number;
  windowCount: number;
}

export interface AcousticSummary {
  coughEventCount: number;
  eventCount: number;
  gaspEventCount: number;
  healthEventCount: number;
  highSeverityCount: number;
  model: string;
  processedChunkCount: number;
  processingSeconds: number;
  wheezeEventCount: number;
  windowCount: number;
}

export interface RiskSummary {
  evidenceCount: number;
  highSeverityCount: number;
  incidentCount: number;
  model: string;
  multimodalIncidentCount: number;
  processingSeconds: number;
}

export interface TranscriptionSummary {
  chunkCount: number;
  completedChunkCount: number;
  failedChunkCount: number;
  transcribedDurationMs: number;
  wordCount: number;
}

export interface CreateAnalysisResponse extends AnalysisResponse {
  upload: {
    expiresAt: Date;
    headers: Record<string, string>;
    method: 'PUT';
    url: string;
  };
}

export interface SegmentResponse {
  confidence?: number;
  endMs: number;
  labels: string[];
  needsAsr: boolean;
  peakDbfs?: number;
  rmsDbfs?: number;
  segmentId: string;
  segmentType: ScanSegmentType;
  sourceIntervalCount?: number;
  speechRatio?: number;
  startMs: number;
}

export interface SegmentPageResponse {
  items: SegmentResponse[];
  limit: number;
  page: number;
  total: number;
}

export interface TranscriptionChunkResponse {
  audioDurationAfterVadSeconds?: number;
  audioDurationSeconds?: number;
  chunkId: string;
  chunkIndex: number;
  durationMs: number;
  endMs: number;
  failureReason?: string;
  language?: string;
  languageMode?: TranscriptionLanguageMode;
  languageProbability?: number;
  model?: string;
  processingSeconds?: number;
  qualityRetryUsed?: boolean;
  extractionSeconds?: number;
  inferenceSeconds?: number;
  vadFallbackUsed?: boolean;
  sourceRegionCount: number;
  ranges: Array<{ endMs: number; startMs: number }>;
  startMs: number;
  status: TranscriptionChunkStatus;
  text?: string;
  words: TranscriptWord[];
}

export interface TranscriptionPageResponse {
  items: TranscriptionChunkResponse[];
  limit: number;
  page: number;
  total: number;
}

export interface ConversationSessionResponse {
  childPresent: boolean;
  endMs: number;
  environment: string;
  contextModel?: string;
  conversationType?: {
    confidence: number;
    label: string;
  };
  profanity?: {
    directedAtChild: 'unknown';
    exposureLevel: string;
    notificationReason?: string;
    notificationRecommended: boolean;
    occurrenceCount: number;
    occurrences: Array<{
      canonicalTerm: string;
      confidence: number;
      endMs: number;
      evidence: string;
      severity: string;
      speakerId: string;
      startMs: number;
      term: string;
    }>;
    severity: string;
    terms: string[];
  };
  quality?: WorkerQualityAssessment;
  safetySignals: WorkerSafetySignal[];
  sessionId: string;
  sessionIndex: number;
  speakers: string[];
  startMs: number;
  utterances: Array<{
    confidence?: number;
    endMs: number;
    speakerId: string;
    startMs: number;
    text: string;
  }>;
}

export interface ConversationPageResponse {
  items: ConversationSessionResponse[];
  limit: number;
  page: number;
  total: number;
}

export interface TimelineEventResponse {
  childInvolvement: 'unknown';
  confidence: number;
  endMs: number;
  eventId: string;
  eventType: string;
  evidence: string;
  model: string;
  severity: string;
  speakerId: string;
  startMs: number;
}

export interface TimelineEventPageResponse {
  items: TimelineEventResponse[];
  limit: number;
  page: number;
  total: number;
}

export interface AcousticEventResponse {
  category: string;
  confidence: number;
  endMs: number;
  eventId: string;
  label: string;
  model: string;
  severity: string;
  startMs: number;
}

export interface AcousticEventPageResponse {
  items: AcousticEventResponse[];
  limit: number;
  page: number;
  total: number;
}

export interface RiskIncidentResponse {
  childInvolvement: 'unknown';
  confidence: number;
  endMs: number;
  evidence: Array<{
    category?: string;
    confidence: number;
    endMs: number;
    evidenceText?: string;
    label: string;
    source: 'transcript' | 'acoustic';
    startMs: number;
  }>;
  incidentId: string;
  incidentType: string;
  modalities: Array<'transcript' | 'acoustic'>;
  rationale: string;
  reviewStatus: 'unreviewed';
  severity: string;
  startMs: number;
}

export interface RiskIncidentPageResponse {
  items: RiskIncidentResponse[];
  limit: number;
  page: number;
  total: number;
}
