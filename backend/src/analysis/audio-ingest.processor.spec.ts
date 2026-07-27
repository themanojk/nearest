/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import { Job, Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { ObjectStorageService } from '../storage/storage.service';
import { AudioIngestProcessor } from './audio-ingest.processor';
import { IngestAudioJob, ScanAudioJob } from './analysis.types';
import { MediaProbeService } from './media-probe.service';
import {
  AnalysisJob,
  AnalysisJobDocument,
  AnalysisStatus,
  MediaMetadata,
  PipelineStageStatus,
} from './schemas/analysis-job.schema';

describe('AudioIngestProcessor', () => {
  const analysisId = '66a111111111111111111111';
  const metadata: MediaMetadata = {
    durationMs: 250,
    formatName: 'wav',
    sizeBytes: 8044,
    bitRate: 257_408,
    audioStreams: [
      {
        index: 0,
        codecName: 'pcm_s16le',
        sampleRate: 16_000,
        channels: 1,
      },
    ],
    probedAt: new Date(),
  };

  function setup(probeError?: Error) {
    const claimed = {
      _id: new Types.ObjectId(analysisId),
      tenantId: 'tenant-a',
      status: AnalysisStatus.Processing,
      ingestStage: {
        status: PipelineStageStatus.Running,
        progress: 10,
        attempts: 1,
      },
    } as unknown as AnalysisJobDocument;
    const updateExec = jest.fn().mockResolvedValue(undefined);
    const updateOne = jest.fn().mockReturnValue({ exec: updateExec });
    const model = {
      findOneAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(claimed),
      }),
      findOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(claimed),
      }),
      updateOne,
    } as unknown as Model<AnalysisJob>;
    const storage = {
      createReadUrl: jest
        .fn()
        .mockResolvedValue('http://object-store/signed-audio'),
    } as unknown as ObjectStorageService;
    const mediaProbe = {
      probe: probeError
        ? jest.fn().mockRejectedValue(probeError)
        : jest.fn().mockResolvedValue(metadata),
    } as unknown as MediaProbeService;
    const scanQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    } as unknown as Queue<ScanAudioJob>;
    const processor = new AudioIngestProcessor(
      model,
      scanQueue,
      storage,
      mediaProbe,
    );

    return { mediaProbe, model, processor, scanQueue, storage, updateOne };
  }

  function job(attemptsMade = 0): Job<IngestAudioJob> {
    return {
      name: 'ingest',
      data: {
        analysisId,
        tenantId: 'tenant-a',
        objectKey: `tenant-a/${analysisId}/source`,
        contentType: 'audio/wav',
        sizeBytes: 8044,
      },
      attemptsMade,
      opts: { attempts: 3 },
    } as Job<IngestAudioJob>;
  }

  it('probes the object and completes the ingestion stage', async () => {
    const { mediaProbe, processor, scanQueue, storage, updateOne } = setup();

    await expect(processor.process(job())).resolves.toEqual(metadata);

    expect(storage.createReadUrl).toHaveBeenCalled();
    expect(mediaProbe.probe).toHaveBeenCalledWith(
      'http://object-store/signed-audio',
    );
    expect(scanQueue.add).toHaveBeenCalledWith(
      'scan',
      expect.objectContaining({
        analysisId,
        tenantId: 'tenant-a',
      }),
      expect.objectContaining({
        jobId: `scan-${analysisId}`,
      }),
    );
    expect(updateOne).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          mediaMetadata: metadata,
          'ingestStage.status': PipelineStageStatus.Completed,
        }),
      }),
    );
  });

  it('returns the job to queued state for a retryable probe failure', async () => {
    const { processor, updateOne } = setup(new Error('probe failed'));

    await expect(processor.process(job(0))).rejects.toThrow('probe failed');

    expect(updateOne).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: AnalysisStatus.Queued,
          'ingestStage.status': PipelineStageStatus.Pending,
        }),
      }),
    );
  });

  it('marks ingestion failed after the final attempt', async () => {
    const { processor, updateOne } = setup(new Error('probe failed'));

    await expect(processor.process(job(2))).rejects.toThrow('probe failed');

    expect(updateOne).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: AnalysisStatus.Failed,
          'ingestStage.status': PipelineStageStatus.Failed,
        }),
      }),
    );
  });
});
