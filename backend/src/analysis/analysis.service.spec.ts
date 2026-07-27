/* eslint-disable @typescript-eslint/unbound-method */
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { getQueueToken } from '@nestjs/bullmq';
import { Model, Types } from 'mongoose';
import { Queue } from 'bullmq';
import { ObjectStorageService } from '../storage/storage.service';
import { AUDIO_INGEST_QUEUE } from './analysis.constants';
import { AnalysisService } from './analysis.service';
import { ClassifyContextJob, IngestAudioJob } from './analysis.types';
import {
  AnalysisJob,
  AnalysisJobDocument,
  AnalysisStatus,
  PipelineStageStatus,
} from './schemas/analysis-job.schema';
import { ScanSegment } from './schemas/scan-segment.schema';
import { TranscriptionChunk } from './schemas/transcription-chunk.schema';
import { ConversationSession } from './schemas/conversation-session.schema';
import { DiarizeAudioJob } from './analysis.types';
import { TimelineEvent } from './schemas/timeline-event.schema';
import { AcousticEvent } from './schemas/acoustic-event.schema';
import {
  DetectAcousticEventsJob,
  AggregateRiskJob,
} from './analysis.types';
import { RiskIncident } from './schemas/risk-incident.schema';

function analysisDocument(
  status: AnalysisStatus = AnalysisStatus.AwaitingUpload,
): AnalysisJobDocument {
  const now = new Date();
  return {
    _id: new Types.ObjectId('66a111111111111111111111'),
    tenantId: 'tenant-a',
    childId: 'child-a',
    sourceObjectKey: 'tenant-a/66a111111111111111111111/source',
    originalFileName: 'day.m4a',
    contentType: 'audio/mp4',
    sizeBytes: 128,
    status,
    progress: 0,
    ingestStage: {
      status: PipelineStageStatus.Pending,
      progress: 0,
      attempts: 0,
    },
    scanStage: {
      status: PipelineStageStatus.Pending,
      progress: 0,
      attempts: 0,
    },
    createdAt: now,
    updatedAt: now,
    save: jest.fn().mockResolvedValue(undefined),
  } as unknown as AnalysisJobDocument;
}

describe('AnalysisService', () => {
  const upload = {
    method: 'PUT' as const,
    url: 'http://object-store/upload',
    headers: { 'content-type': 'audio/mp4' },
    expiresAt: new Date(),
  };

  function setup(document = analysisDocument()) {
    const model = {
      create: jest.fn().mockResolvedValue(document),
      deleteOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(undefined),
      }),
      findOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(document),
      }),
      findOneAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockImplementation(() => {
          document.status = AnalysisStatus.Queued;
          return Promise.resolve(document);
        }),
      }),
    } as unknown as Model<AnalysisJob>;
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
    } as unknown as Queue<IngestAudioJob>;
    const segmentModel = {} as Model<ScanSegment>;
    const transcriptionModel = {} as Model<TranscriptionChunk>;
    const conversationModel = {} as Model<ConversationSession>;
    const eventModel = {} as Model<TimelineEvent>;
    const acousticEventModel = {} as Model<AcousticEvent>;
    const riskIncidentModel = {} as Model<RiskIncident>;
    const diarizationQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    } as unknown as Queue<DiarizeAudioJob>;
    const contextQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    } as unknown as Queue<ClassifyContextJob>;
    const acousticQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    } as unknown as Queue<DetectAcousticEventsJob>;
    const riskQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    } as unknown as Queue<AggregateRiskJob>;
    const storage = {
      createUploadUrl: jest.fn().mockResolvedValue(upload),
      createPlaybackUrl: jest.fn().mockResolvedValue({
        url: 'http://object-store/playback',
        expiresAt: new Date('2026-07-24T13:00:00.000Z'),
      }),
      assertObject: jest.fn().mockResolvedValue({
        contentLength: 128,
        contentType: 'audio/mp4',
      }),
    } as unknown as ObjectStorageService;
    const config = {
      getOrThrow: jest.fn().mockReturnValue(1024),
    } as unknown as ConfigService;

    return {
      model,
      queue,
      service: new AnalysisService(
        model,
        segmentModel,
        transcriptionModel,
        conversationModel,
        eventModel,
        acousticEventModel,
        riskIncidentModel,
        queue,
        diarizationQueue,
        contextQueue,
        acousticQueue,
        riskQueue,
        storage,
        config,
      ),
      storage,
    };
  }

  it('creates an awaiting-upload analysis and returns a signed URL', async () => {
    const { model, service, storage } = setup();

    const result = await service.create('tenant-a', {
      childId: 'child-a',
      fileName: 'day.m4a',
      contentType: 'audio/mp4',
      sizeBytes: 128,
    });

    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        childId: 'child-a',
        status: AnalysisStatus.AwaitingUpload,
      }),
    );
    expect(storage.createUploadUrl).toHaveBeenCalledWith(
      expect.stringMatching(/^tenant-a\/[a-f0-9]{24}\/source$/),
      'audio/mp4',
    );
    expect(result.upload).toEqual(upload);
  });

  it('verifies the object and enqueues a deterministic ingestion job', async () => {
    const document = analysisDocument();
    const { queue, service, storage } = setup(document);

    const result = await service.completeUpload(
      'tenant-a',
      document._id.toString(),
    );

    expect(storage.assertObject).toHaveBeenCalledWith(
      document.sourceObjectKey,
      128,
    );
    expect(queue.add).toHaveBeenCalledWith(
      'ingest',
      expect.objectContaining({
        analysisId: document._id.toString(),
        tenantId: 'tenant-a',
      }),
      expect.objectContaining({
        jobId: `ingest-${document._id.toString()}`,
      }),
    );
    expect(result.status).toBe(AnalysisStatus.Queued);
    expect(document.save).toHaveBeenCalled();
  });

  it('does not enqueue an analysis that is already queued', async () => {
    const document = analysisDocument(AnalysisStatus.Queued);
    const { queue, service, storage } = setup(document);

    await service.completeUpload('tenant-a', document._id.toString());

    expect(storage.assertObject).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('returns a tenant-scoped signed playback URL', async () => {
    const document = analysisDocument(AnalysisStatus.Completed);
    const { service, storage } = setup(document);

    const result = await service.getPlayback(
      'tenant-a',
      document._id.toString(),
    );

    expect(storage.createPlaybackUrl).toHaveBeenCalledWith(
      document.sourceObjectKey,
    );
    expect(result).toMatchObject({
      contentType: 'audio/mp4',
      fileName: 'day.m4a',
      url: 'http://object-store/playback',
    });
  });

  it('uses the Nest injection tokens expected by the module', () => {
    expect(getModelToken(AnalysisJob.name)).toBe('AnalysisJobModel');
    expect(getQueueToken(AUDIO_INGEST_QUEUE)).toContain(AUDIO_INGEST_QUEUE);
  });
});
