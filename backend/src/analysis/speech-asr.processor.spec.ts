/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import { Job, Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { ObjectStorageService } from '../storage/storage.service';
import { SpeechAsrProcessor } from './speech-asr.processor';
import {
  TranscribeAudioJob,
  DiarizeAudioJob,
  WorkerTranscriptionResponse,
} from './analysis.types';
import {
  AnalysisJob,
  AnalysisStatus,
  PipelineStageStatus,
  TranscriptionLanguageMode,
} from './schemas/analysis-job.schema';
import {
  TranscriptionChunk,
  TranscriptionChunkStatus,
} from './schemas/transcription-chunk.schema';
import { WorkerClientService } from './worker-client.service';

describe('SpeechAsrProcessor', () => {
  const analysisId = '66a111111111111111111111';
  const chunkId = '66a222222222222222222222';

  it('persists timestamped text and completes the analysis', async () => {
    const analysisUpdate = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(undefined),
    });
    const analysisModel = {
      updateOne: analysisUpdate,
      findOneAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      }),
    } as unknown as Model<AnalysisJob>;
    const chunkUpdate = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(undefined),
    });
    const transcriptionModel = {
      findOneAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(chunkId),
          status: TranscriptionChunkStatus.Running,
        }),
      }),
      findById: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      }),
      updateOne: chunkUpdate,
      countDocuments: jest.fn((filter: { status?: string }) => ({
        exec: jest.fn().mockResolvedValue(
          filter.status === TranscriptionChunkStatus.Failed ? 0 : 1,
        ),
      })),
      aggregate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([
          { transcribedDurationMs: 10_000, wordCount: 2 },
        ]),
      }),
    } as unknown as Model<TranscriptionChunk>;
    const storage = {
      createReadUrl: jest.fn().mockResolvedValue('http://storage/audio'),
    } as unknown as ObjectStorageService;
    const result: WorkerTranscriptionResponse = {
      analysisId,
      chunkId,
      model: 'small',
      language: 'en',
      languageMode: TranscriptionLanguageMode.Auto,
      languageProbability: 0.98,
      processingSeconds: 1.2,
      extractionSeconds: 0.2,
      inferenceSeconds: 1,
      audioDurationSeconds: 10,
      audioDurationAfterVadSeconds: 8,
      vadFallbackUsed: false,
      qualityRetryUsed: false,
      text: 'hello world',
      words: [
        { startMs: 10_100, endMs: 10_400, text: ' hello', probability: 0.9 },
        { startMs: 10_450, endMs: 10_900, text: ' world', probability: 0.88 },
      ],
    };
    const workerClient = {
      transcribeAudio: jest.fn().mockResolvedValue(result),
    } as unknown as WorkerClientService;
    const diarizationQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    } as unknown as Queue<DiarizeAudioJob>;
    const processor = new SpeechAsrProcessor(
      analysisModel,
      transcriptionModel,
      diarizationQueue,
      storage,
      workerClient,
    );
    const job = {
      name: 'transcribe',
      data: {
        analysisId,
        chunkId,
        tenantId: 'tenant-a',
        objectKey: `tenant-a/${analysisId}/source`,
        startMs: 10_000,
        endMs: 20_000,
        ranges: [{ startMs: 10_000, endMs: 20_000 }],
        transcriptionLanguageMode: TranscriptionLanguageMode.Auto,
      },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as Job<TranscribeAudioJob>;

    await expect(processor.process(job)).resolves.toBeUndefined();

    expect(workerClient.transcribeAudio).toHaveBeenCalledWith(
      analysisId,
      chunkId,
      'http://storage/audio',
      10_000,
      20_000,
      [{ startMs: 10_000, endMs: 20_000 }],
      TranscriptionLanguageMode.Auto,
    );
    expect(chunkUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: TranscriptionChunkStatus.Completed,
          text: 'hello world',
          modelName: 'small',
        }),
      }),
    );
    expect(analysisUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: AnalysisStatus.Processing,
          'transcriptionStage.status': PipelineStageStatus.Completed,
          'diarizationStage.status': PipelineStageStatus.Queueing,
        }),
      }),
    );
  });
});
