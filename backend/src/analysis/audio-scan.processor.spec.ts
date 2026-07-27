/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import { Job, Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { ObjectStorageService } from '../storage/storage.service';
import { AudioScanProcessor } from './audio-scan.processor';
import {
  ScanAudioJob,
  TranscribeAudioJob,
  WorkerScanResponse,
} from './analysis.types';
import {
  AnalysisJob,
  AnalysisStatus,
  PipelineStageStatus,
} from './schemas/analysis-job.schema';
import { ScanSegment } from './schemas/scan-segment.schema';
import { TranscriptionChunk } from './schemas/transcription-chunk.schema';
import { WorkerClientService } from './worker-client.service';

describe('AudioScanProcessor', () => {
  const analysisId = '66a111111111111111111111';
  const workerResult: WorkerScanResponse = {
    analysisId,
    pipelineVersion: 'webrtc-vad/1.0.0',
    capabilities: ['webrtc_vad', 'audio_quality', 'logical_windows'],
    sampleRate: 16_000,
    vadMode: 2,
    windows: [
      {
        startMs: 0,
        endMs: 1_000,
        speechRatio: 1,
        rmsDbfs: -23,
        peakDbfs: -20,
        labels: ['speech_candidate'],
      },
    ],
    speechIntervals: [
      {
        startMs: 0,
        endMs: 990,
        confidence: 0.9,
      },
    ],
    summary: {
      decodedDurationMs: 990,
      processingSeconds: 0.1,
      speechDurationMs: 990,
      speechRatio: 1,
      windowCount: 1,
      speechIntervalCount: 1,
    },
  };

  function setup(workerError?: Error) {
    const updateOne = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(undefined),
    });
    const analysisModel = {
      findOneAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(analysisId),
          tenantId: 'tenant-a',
          status: AnalysisStatus.Processing,
          scanStage: {
            status: PipelineStageStatus.Running,
            progress: 10,
            attempts: 1,
          },
        }),
      }),
      findOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      }),
      updateOne,
    } as unknown as Model<AnalysisJob>;
    const deleteMany = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(undefined),
    });
    const insertMany = jest.fn().mockResolvedValue([]);
    const segmentModel = {
      deleteMany,
      insertMany,
    } as unknown as Model<ScanSegment>;
    const transcriptionModel = {
      deleteMany: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(undefined),
      }),
      insertMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(undefined),
      }),
    } as unknown as Model<TranscriptionChunk>;
    const asrQueue = {
      addBulk: jest.fn().mockResolvedValue([]),
    } as unknown as Queue<TranscribeAudioJob>;
    const storage = {
      createReadUrl: jest
        .fn()
        .mockResolvedValue('http://object-store/signed-audio'),
    } as unknown as ObjectStorageService;
    const workerClient = {
      scanAudio: workerError
        ? jest.fn().mockRejectedValue(workerError)
        : jest.fn().mockResolvedValue(workerResult),
    } as unknown as WorkerClientService;
    const processor = new AudioScanProcessor(
      analysisModel,
      segmentModel,
      transcriptionModel,
      asrQueue,
      storage,
      workerClient,
      {
        getOrThrow: jest.fn((key: string) => {
          const values: Record<string, number> = {
            LOGICAL_TRIM_CONTEXT_AFTER_MS: 400,
            LOGICAL_TRIM_CONTEXT_BEFORE_MS: 250,
            LOGICAL_TRIM_MAX_GAP_MS: 500,
            LOGICAL_TRIM_MIN_REGION_MS: 500,
            ASR_MAX_CHUNK_MS: 60_000,
          };
          return values[key];
        }),
      } as unknown as ConfigService,
    );

    return {
      deleteMany,
      insertMany,
      processor,
      storage,
      updateOne,
      workerClient,
    };
  }

  function job(attemptsMade = 0): Job<ScanAudioJob> {
    return {
      name: 'scan',
      data: {
        analysisId,
        tenantId: 'tenant-a',
        objectKey: `tenant-a/${analysisId}/source`,
      },
      attemptsMade,
      opts: { attempts: 3 },
    } as Job<ScanAudioJob>;
  }

  it('persists scan windows, speech intervals, and summary', async () => {
    const {
      deleteMany,
      insertMany,
      processor,
      storage,
      updateOne,
      workerClient,
    } = setup();

    await expect(processor.process(job())).resolves.toEqual(
      expect.objectContaining({
        ...workerResult.summary,
        pipelineVersion: workerResult.pipelineVersion,
        processingRegionCount: 1,
        retainedDurationMs: 990,
        retainedRatio: 1,
        removedSilenceDurationMs: 0,
      }),
    );

    expect(storage.createReadUrl).toHaveBeenCalled();
    expect(workerClient.scanAudio).toHaveBeenCalledWith(
      analysisId,
      'http://object-store/signed-audio',
    );
    expect(deleteMany).toHaveBeenCalled();
    expect(insertMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          segmentType: 'SCAN_WINDOW',
          needsAsr: true,
        }),
        expect.objectContaining({
          segmentType: 'SPEECH_INTERVAL',
          needsAsr: true,
        }),
        expect.objectContaining({
          segmentType: 'PROCESSING_REGION',
          startMs: 0,
          endMs: 990,
          sourceIntervalCount: 1,
          needsAsr: true,
        }),
      ]),
      { ordered: true },
    );
    expect(updateOne).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          progress: 25,
          'scanStage.status': PipelineStageStatus.Completed,
        }),
      }),
    );
  });

  it('marks a terminal worker failure on the final attempt', async () => {
    const { processor, updateOne } = setup(
      new Error('Audio scan worker is unavailable'),
    );

    await expect(processor.process(job(2))).rejects.toThrow(
      'Audio scan worker is unavailable',
    );

    expect(updateOne).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: AnalysisStatus.Failed,
          'scanStage.status': PipelineStageStatus.Failed,
        }),
      }),
    );
  });
});
