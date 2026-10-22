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
  AudioUploadMode,
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
    uploadMode: AudioUploadMode.Single,
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
      updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }) }),
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
    const riskIncidentModel = { deleteMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }) } as unknown as Model<RiskIncident>;
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
      deleteObject: jest.fn().mockResolvedValue(undefined),
      createUploadUrl: jest.fn().mockResolvedValue(upload),
      createMultipartUpload: jest.fn().mockResolvedValue('multipart-upload-a'),
      createMultipartPartUrl: jest.fn().mockImplementation(
        (_key: string, _uploadId: string, partNumber: number) =>
          Promise.resolve({
            method: 'PUT',
            partNumber,
            url: `http://object-store/part/${partNumber}`,
            expiresAt: new Date(),
          }),
      ),
      listMultipartParts: jest.fn().mockResolvedValue([]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      ensureFlacPlayback: jest.fn().mockResolvedValue('converted/playback.wav'),
      deleteFlacPlayback: jest.fn().mockResolvedValue(undefined),
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
      getOrThrow: jest.fn().mockReturnValue(10 * 1024 * 1024 * 1024),
    } as unknown as ConfigService;

    return {
      model,
      contextQueue,
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

  it('deletes owned terminal audio but preserves its diagnostic record', async () => {
    const document = analysisDocument(AnalysisStatus.Completed);
    const { service, storage, model } = setup(document);
    const result = await service.deleteAudio('tenant-a', document._id.toString());
    expect(model.findOne).toHaveBeenCalledWith({ _id: document._id, tenantId: 'tenant-a' });
    expect(storage.deleteObject).toHaveBeenCalledWith(document.sourceObjectKey);
    expect(document.save).toHaveBeenCalled();
    expect(result.audioDeletedAt).toBeInstanceOf(Date);
    expect(model.deleteOne).not.toHaveBeenCalled();
    await expect(service.getPlayback('tenant-a', document._id.toString())).rejects.toThrow('Audio has been deleted');
    await service.deleteAudio('tenant-a', document._id.toString());
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
  });

  it('rejects deletion during upload or processing', async () => {
    const { service, storage } = setup();
    await expect(service.deleteAudio('tenant-a', '66a111111111111111111111')).rejects.toThrow('Wait for upload');
    expect(storage.deleteObject).not.toHaveBeenCalled();
    const document = analysisDocument(AnalysisStatus.Completed);
    document.scanStage.status = PipelineStageStatus.Running;
    const running = setup(document);
    await expect(running.service.deleteAudio('tenant-a', document._id.toString())).rejects.toThrow('Wait for upload');
    expect(running.storage.deleteObject).not.toHaveBeenCalled();
  });

  it('does not mark audio deleted when object storage fails', async () => {
    const document = analysisDocument(AnalysisStatus.Completed);
    const { service, storage } = setup(document);
    (storage.deleteObject as jest.Mock).mockRejectedValue(new Error('storage unavailable'));
    await expect(service.deleteAudio('tenant-a', document._id.toString())).rejects.toThrow('storage unavailable');
    expect(document.audioDeletedAt).toBeUndefined();
    expect(document.save).not.toHaveBeenCalled();
  });

  it('does not delete audio outside the authenticated tenant', async () => {
    const { service, model, storage } = setup();
    (model.findOne as jest.Mock).mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
    await expect(service.deleteAudio('tenant-b', '66a111111111111111111111')).rejects.toThrow();
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('queues forced regeneration and allows retry after queue failure', async () => {
    const document = analysisDocument(AnalysisStatus.Completed);
    document.conversationStage = { status: PipelineStageStatus.Completed, progress: 100, attempts: 1 };
    document.contextStage = { status: PipelineStageStatus.Completed, progress: 100, attempts: 1 };
    const { service, contextQueue, model } = setup(document);
    await service.startContextClassification('tenant-a', document._id.toString(), { force: true });
    expect(contextQueue.add).toHaveBeenCalledWith('classify', { analysisId: document._id.toString(), tenantId: 'tenant-a' }, expect.objectContaining({ attempts: 3 }));
    (contextQueue.add as jest.Mock).mockRejectedValueOnce(new Error('Queue offline'));
    await expect(service.startContextClassification('tenant-a', document._id.toString(), { force: true })).rejects.toThrow('Queue offline');
    expect(model.updateOne).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: 'tenant-a' }), expect.objectContaining({ $set: expect.objectContaining({ 'contextStage.status': PipelineStageStatus.Failed }) }));
  });

  it('does not enqueue when another request already claimed regeneration', async () => {
    const document = analysisDocument(AnalysisStatus.Completed);
    document.conversationStage = { status: PipelineStageStatus.Completed, progress: 100, attempts: 1 };
    const { service, contextQueue, model } = setup(document);
    (model.updateOne as jest.Mock).mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: 0 }) });
    await service.startContextClassification('tenant-a', document._id.toString(), { force: true });
    expect(contextQueue.add).not.toHaveBeenCalled();
  });

  it('rejects regeneration when the original recording was deleted', async () => {
    const document = analysisDocument(AnalysisStatus.Completed);
    document.audioDeletedAt = new Date();
    const { service } = setup(document);
    await expect(service.startContextClassification('tenant-a', document._id.toString(), { force: true })).rejects.toThrow('Original audio was deleted');
  });

  it('does not restart context while downstream risk analysis is running', async () => {
    const document = analysisDocument(AnalysisStatus.Processing);
    document.conversationStage = { status: PipelineStageStatus.Completed, progress: 100, attempts: 1 };
    document.riskStage = { status: PipelineStageStatus.Running, progress: 10, attempts: 1 };
    const { service } = setup(document);
    const result = await service.startContextClassification('tenant-a', document._id.toString(), { force: true });
    expect(result.status).toBe(AnalysisStatus.Processing);
  });

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

  it('creates a resumable multipart upload for wearable audio', async () => {
    const { model, service, storage } = setup();

    const result = await service.create('tenant-a', {
      childId: 'child-a',
      fileName: 'full-day.wav',
      contentType: 'audio/wav',
      sizeBytes: 25 * 1024 * 1024,
      uploadMode: AudioUploadMode.Multipart,
    });

    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadMode: AudioUploadMode.Multipart,
        multipartPartCount: 3,
        multipartPartSizeBytes: 10 * 1024 * 1024,
      }),
    );
    expect(storage.createMultipartUpload).toHaveBeenCalled();
    expect(result.multipart).toEqual({
      partCount: 3,
      partSizeBytes: 10 * 1024 * 1024,
    });
    expect(result.upload).toBeUndefined();
  });

  it('issues multipart URLs only for requested in-range chunks', async () => {
    const document = analysisDocument();
    document.uploadMode = AudioUploadMode.Multipart;
    document.multipartUploadId = 'multipart-upload-a';
    document.multipartPartCount = 3;
    document.multipartPartSizeBytes = 10 * 1024 * 1024;
    const { service, storage } = setup(document);

    const result = await service.createMultipartPartUrls(
      'tenant-a',
      document._id.toString(),
      { partNumbers: [3, 1, 1] },
    );

    expect(result.parts.map((part) => part.partNumber)).toEqual([1, 3]);
    expect(storage.createMultipartPartUrl).toHaveBeenCalledTimes(2);
    await expect(
      service.createMultipartPartUrls(
        'tenant-a',
        document._id.toString(),
        { partNumbers: [4] },
      ),
    ).rejects.toThrow('out of range');
  });

  it('completes only when every multipart byte is present', async () => {
    const document = analysisDocument();
    document.uploadMode = AudioUploadMode.Multipart;
    document.multipartUploadId = 'multipart-upload-a';
    document.multipartPartCount = 1;
    document.multipartPartSizeBytes = 10 * 1024 * 1024;
    const { queue, service, storage } = setup(document);
    (storage.listMultipartParts as jest.Mock).mockResolvedValue([
      { partNumber: 1, etag: '"etag-a"', sizeBytes: 128 },
    ]);

    const result = await service.completeMultipartUpload(
      'tenant-a',
      document._id.toString(),
    );

    expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
      document.sourceObjectKey,
      'multipart-upload-a',
      [{ partNumber: 1, etag: '"etag-a"', sizeBytes: 128 }],
    );
    expect(storage.assertObject).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalled();
    expect(result.status).toBe(AnalysisStatus.Queued);
  });

  it('does not enqueue an analysis that is already queued', async () => {
    const document = analysisDocument(AnalysisStatus.Queued);
    const { queue, service, storage } = setup(document);

    await service.completeUpload('tenant-a', document._id.toString());

    expect(storage.assertObject).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('serves MP3 directly without FLAC conversion', async () => {
    const document = analysisDocument(AnalysisStatus.Completed);
    document.contentType = 'audio/mpeg';
    document.originalFileName = 'recording.mp3';
    const { service, storage } = setup(document);
    const result = await service.getPlayback('tenant-a', document._id.toString());
    expect(storage.ensureFlacPlayback).not.toHaveBeenCalled();
    expect(storage.createPlaybackUrl).toHaveBeenCalledWith(document.sourceObjectKey);
    expect(result).toMatchObject({ contentType: 'audio/mpeg', fileName: 'recording.mp3' });
  });

  it('serves a compatible playback copy for existing FLAC imports', async () => {
    const document = analysisDocument(AnalysisStatus.Completed);
    document.contentType = 'audio/flac';
    document.originalFileName = 'recording.flac';
    const { service, storage } = setup(document);
    const result = await service.getPlayback('tenant-a', document._id.toString());
    expect(storage.ensureFlacPlayback).toHaveBeenCalledWith(document.sourceObjectKey);
    expect(storage.createPlaybackUrl).toHaveBeenCalledWith('converted/playback.wav');
    expect(result).toMatchObject({ contentType: 'audio/wav', fileName: 'recording.wav' });
    expect(document.contentType).toBe('audio/flac');
  });

  it('recognizes FLAC filenames when the upload MIME type is generic', async () => {
    const document = analysisDocument(AnalysisStatus.Completed);
    document.contentType = 'application/octet-stream';
    document.originalFileName = 'recording.FLAC';
    const { service, storage } = setup(document);
    await service.getPlayback('tenant-a', document._id.toString());
    expect(storage.ensureFlacPlayback).toHaveBeenCalled();
  });

  it('deletes the FLAC playback copy along with the source audio', async () => {
    const document = analysisDocument(AnalysisStatus.Completed);
    document.contentType = 'audio/flac';
    const { service, storage } = setup(document);
    await service.deleteAudio('tenant-a', document._id.toString());
    expect(storage.deleteFlacPlayback).toHaveBeenCalledWith(document.sourceObjectKey);
    expect(storage.deleteObject).toHaveBeenCalledWith(document.sourceObjectKey);
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
