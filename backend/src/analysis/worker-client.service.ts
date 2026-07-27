import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WorkerDiarizationResponse,
  WorkerContextClassificationResponse,
  WorkerScanResponse,
  WorkerTranscriptionResponse,
  WorkerAcousticDetectionResponse,
} from './analysis.types';
import { TranscriptionLanguageMode } from './schemas/analysis-job.schema';

export class WorkerRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerRequestError';
  }
}

function isWorkerTranscriptionResponse(
  value: unknown,
): value is WorkerTranscriptionResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<WorkerTranscriptionResponse>;
  return (
    typeof response.analysisId === 'string' &&
    typeof response.chunkId === 'string' &&
    typeof response.model === 'string' &&
    typeof response.text === 'string' &&
    typeof response.processingSeconds === 'number' &&
    typeof response.extractionSeconds === 'number' &&
    typeof response.inferenceSeconds === 'number' &&
    typeof response.audioDurationSeconds === 'number' &&
    typeof response.vadFallbackUsed === 'boolean' &&
    typeof response.qualityRetryUsed === 'boolean' &&
    typeof response.languageMode === 'string' &&
    Array.isArray(response.words)
  );
}

function isWorkerScanResponse(value: unknown): value is WorkerScanResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const response = value as Partial<WorkerScanResponse>;
  return (
    typeof response.analysisId === 'string' &&
    typeof response.pipelineVersion === 'string' &&
    Array.isArray(response.windows) &&
    Array.isArray(response.speechIntervals) &&
    !!response.summary &&
    typeof response.summary === 'object'
  );
}

function isWorkerDiarizationResponse(
  value: unknown,
): value is WorkerDiarizationResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<WorkerDiarizationResponse>;
  return (
    typeof response.analysisId === 'string' &&
    typeof response.model === 'string' &&
    typeof response.processingSeconds === 'number' &&
    typeof response.speakerCount === 'number' &&
    Array.isArray(response.turns)
  );
}

function isWorkerContextResponse(
  value: unknown,
): value is WorkerContextClassificationResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<WorkerContextClassificationResponse>;
  return (
    typeof response.analysisId === 'string' &&
    typeof response.model === 'string' &&
    typeof response.processingSeconds === 'number' &&
    Array.isArray(response.sessions)
  );
}

function isWorkerAcousticResponse(
  value: unknown,
): value is WorkerAcousticDetectionResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<WorkerAcousticDetectionResponse>;
  return (
    typeof response.analysisId === 'string' &&
    typeof response.chunkId === 'string' &&
    typeof response.model === 'string' &&
    typeof response.processingSeconds === 'number' &&
    typeof response.windowCount === 'number' &&
    Array.isArray(response.events)
  );
}

@Injectable()
export class WorkerClientService {
  private readonly baseUrl: string;
  private readonly overlapMs: number;
  private readonly timeoutMs: number;
  private readonly vadMode: number;
  private readonly windowMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('WORKER_BASE_URL').replace(
      /\/$/,
      '',
    );
    this.timeoutMs = config.getOrThrow<number>('WORKER_REQUEST_TIMEOUT_MS');
    this.windowMs = config.getOrThrow<number>('SCAN_WINDOW_MS');
    this.overlapMs = config.getOrThrow<number>('SCAN_OVERLAP_MS');
    this.vadMode = config.getOrThrow<number>('VAD_MODE');
  }

  async scanAudio(
    analysisId: string,
    sourceUrl: string,
  ): Promise<WorkerScanResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/scan`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          analysisId,
          sourceUrl,
          sampleRate: 16_000,
          frameMs: 30,
          windowMs: this.windowMs,
          overlapMs: this.overlapMs,
          vadMode: this.vadMode,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new WorkerRequestError('Audio scan worker is unavailable');
    }

    if (!response.ok) {
      throw new WorkerRequestError(
        `Audio scan worker rejected the request with status ${response.status}`,
      );
    }

    const body: unknown = await response.json();
    if (!isWorkerScanResponse(body) || body.analysisId !== analysisId) {
      throw new WorkerRequestError('Audio scan worker returned invalid data');
    }
    return body;
  }

  async transcribeAudio(
    analysisId: string,
    chunkId: string,
    sourceUrl: string,
    startMs: number,
    endMs: number,
    ranges: Array<{ endMs: number; startMs: number }>,
    transcriptionLanguageMode: TranscriptionLanguageMode,
  ): Promise<WorkerTranscriptionResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          analysisId,
          chunkId,
          sourceUrl,
          startMs,
          endMs,
          ranges,
          languageMode: transcriptionLanguageMode,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new WorkerRequestError('Transcription worker is unavailable');
    }
    if (!response.ok) {
      throw new WorkerRequestError(
        `Transcription worker rejected the request with status ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (
      !isWorkerTranscriptionResponse(body) ||
      body.analysisId !== analysisId ||
      body.chunkId !== chunkId
    ) {
      throw new WorkerRequestError(
        'Transcription worker returned invalid data',
      );
    }
    return body;
  }

  async diarizeAudio(
    analysisId: string,
    sourceUrl: string,
    words: Array<{ endMs: number; startMs: number; text: string }>,
  ): Promise<WorkerDiarizationResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/diarize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ analysisId, sourceUrl, words }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new WorkerRequestError('Diarization worker is unavailable');
    }
    if (!response.ok) {
      throw new WorkerRequestError(
        `Diarization worker rejected the request with status ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (
      !isWorkerDiarizationResponse(body) ||
      body.analysisId !== analysisId
    ) {
      throw new WorkerRequestError('Diarization worker returned invalid data');
    }
    return body;
  }

  async classifyContext(
    analysisId: string,
    sessions: Array<{
      endMs: number;
      sessionId: string;
      speakers: string[];
      startMs: number;
      utterances: Array<{
        confidence?: number;
        endMs: number;
        speakerId: string;
        startMs: number;
        text: string;
      }>;
    }>,
  ): Promise<WorkerContextClassificationResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/classify-context`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ analysisId, sessions }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new WorkerRequestError('Context worker is unavailable');
    }
    if (!response.ok) {
      throw new WorkerRequestError(
        `Context worker rejected the request with status ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (!isWorkerContextResponse(body) || body.analysisId !== analysisId) {
      throw new WorkerRequestError('Context worker returned invalid data');
    }
    return body;
  }

  async detectAcousticEvents(
    analysisId: string,
    chunkId: string,
    sourceUrl: string,
    ranges: Array<{ endMs: number; startMs: number }>,
  ): Promise<WorkerAcousticDetectionResponse> {
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/v1/detect-acoustic-events`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            analysisId,
            chunkId,
            sourceUrl,
            ranges,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      throw new WorkerRequestError('Acoustic-event worker is unavailable');
    }
    if (!response.ok) {
      throw new WorkerRequestError(
        `Acoustic-event worker rejected the request with status ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (
      !isWorkerAcousticResponse(body) ||
      body.analysisId !== analysisId ||
      body.chunkId !== chunkId
    ) {
      throw new WorkerRequestError(
        'Acoustic-event worker returned invalid data',
      );
    }
    return body;
  }
}
