export type AnalysisStatus =
  | 'AWAITING_UPLOAD'
  | 'QUEUEING'
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED';

export type StageStatus =
  | 'PENDING'
  | 'QUEUEING'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED';

export type TranscriptionLanguageMode =
  | 'AUTO'
  | 'ENGLISH'
  | 'HINDI_HINGLISH';

export interface StageProgress {
  attempts: number;
  progress: number;
  status: StageStatus;
  updatedAt?: string;
}

export interface MediaMetadata {
  audioStreams: Array<{
    channelLayout?: string;
    channels?: number;
    codecName: string;
    index: number;
    sampleRate?: number;
  }>;
  bitRate?: number;
  durationMs: number;
  formatName: string;
  probedAt: string;
  sizeBytes?: number;
}

export interface ScanSummary {
  decodedDurationMs: number;
  pipelineVersion: string;
  processingSeconds: number;
  processingRegionCount: number;
  removedSilenceDurationMs: number;
  retainedDurationMs: number;
  retainedRatio: number;
  speechDurationMs: number;
  speechIntervalCount: number;
  speechRatio: number;
  windowCount: number;
}

export interface Analysis {
  acousticStage: StageProgress;
  acousticSummary?: AcousticSummary;
  riskStage: StageProgress;
  riskSummary?: RiskSummary;
  analysisId: string;
  childId: string;
  conversationStage: StageProgress;
  conversationSummary?: ConversationSummary;
  contextStage: StageProgress;
  contextSummary?: ContextSummary;
  contentType: string;
  createdAt: string;
  fileName: string;
  diarizationStage: StageProgress;
  diarizationSummary?: DiarizationSummary;
  ingestStage: StageProgress;
  mediaMetadata?: MediaMetadata;
  progress: number;
  scanStage: StageProgress;
  scanSummary?: ScanSummary;
  transcriptionStage: StageProgress;
  transcriptionLanguageMode: TranscriptionLanguageMode;
  transcriptionSummary?: TranscriptionSummary;
  sizeBytes: number;
  status: AnalysisStatus;
  updatedAt: string;
}

export interface AnalysisPage {
  items: Analysis[];
  limit: number;
  page: number;
  total: number;
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

export interface TranscriptWord {
  endMs: number;
  probability?: number;
  startMs: number;
  text: string;
}

export interface TranscriptionChunk {
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
  ranges: Array<{ endMs: number; startMs: number }>;
  sourceRegionCount: number;
  startMs: number;
  status: StageStatus;
  text?: string;
  words: TranscriptWord[];
}

export interface TranscriptionPage {
  items: TranscriptionChunk[];
  limit: number;
  page: number;
  total: number;
}

export interface CreateAnalysisResponse extends Analysis {
  upload: {
    expiresAt: string;
    headers: Record<string, string>;
    method: 'PUT';
    url: string;
  };
}

export interface AudioPlayback {
  contentType: string;
  expiresAt: string;
  fileName: string;
  url: string;
}

export interface Segment {
  confidence?: number;
  endMs: number;
  labels: string[];
  needsAsr: boolean;
  peakDbfs?: number;
  rmsDbfs?: number;
  segmentId: string;
  segmentType: 'SCAN_WINDOW' | 'SPEECH_INTERVAL' | 'PROCESSING_REGION';
  sourceIntervalCount?: number;
  speechRatio?: number;
  startMs: number;
}

export interface SegmentPage {
  items: Segment[];
  limit: number;
  page: number;
  total: number;
}

export interface ConversationUtterance {
  confidence?: number;
  endMs: number;
  speakerId: string;
  startMs: number;
  text: string;
}

export interface ConversationSession {
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
  quality?: {
    cleanedText: string;
    flags: string[];
    score: number;
    usable: boolean;
  };
  safetySignals: TimelineEventSignal[];
  sessionId: string;
  sessionIndex: number;
  speakers: string[];
  startMs: number;
  utterances: ConversationUtterance[];
}

export interface ConversationPage {
  items: ConversationSession[];
  limit: number;
  page: number;
  total: number;
}

export interface TimelineEventSignal {
  confidence: number;
  endMs: number;
  evidence: string;
  severity: string;
  signalType: string;
  speakerId: string;
  startMs: number;
}

export interface TimelineEvent {
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

export interface TimelineEventPage {
  items: TimelineEvent[];
  limit: number;
  page: number;
  total: number;
}

export interface AcousticEvent {
  category: string;
  confidence: number;
  endMs: number;
  eventId: string;
  label: string;
  model: string;
  severity: string;
  startMs: number;
}

export interface AcousticEventPage {
  items: AcousticEvent[];
  limit: number;
  page: number;
  total: number;
}

export interface RiskIncident {
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

export interface RiskIncidentPage {
  items: RiskIncident[];
  limit: number;
  page: number;
  total: number;
}
