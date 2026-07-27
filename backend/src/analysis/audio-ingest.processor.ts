import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job, Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { ObjectStorageService } from '../storage/storage.service';
import {
  AUDIO_INGEST_JOB,
  AUDIO_INGEST_QUEUE,
  AUDIO_SCAN_JOB,
  AUDIO_SCAN_QUEUE,
} from './analysis.constants';
import { IngestAudioJob, ScanAudioJob } from './analysis.types';
import { MediaProbeService } from './media-probe.service';
import {
  AnalysisJob,
  AnalysisStatus,
  MediaMetadata,
  PipelineStageStatus,
} from './schemas/analysis-job.schema';

@Processor(AUDIO_INGEST_QUEUE, { concurrency: 2 })
export class AudioIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(AudioIngestProcessor.name);

  constructor(
    @InjectModel(AnalysisJob.name)
    private readonly analysisModel: Model<AnalysisJob>,
    @InjectQueue(AUDIO_SCAN_QUEUE)
    private readonly scanQueue: Queue<ScanAudioJob>,
    private readonly storage: ObjectStorageService,
    private readonly mediaProbe: MediaProbeService,
  ) {
    super();
  }

  async process(job: Job<IngestAudioJob>): Promise<MediaMetadata> {
    if (job.name !== AUDIO_INGEST_JOB) {
      throw new Error(`Unsupported ingestion job: ${job.name}`);
    }

    const analysisId = new Types.ObjectId(job.data.analysisId);
    const now = new Date();
    const claimed = await this.analysisModel
      .findOneAndUpdate(
        {
          _id: analysisId,
          tenantId: job.data.tenantId,
          status: {
            $in: [AnalysisStatus.Queueing, AnalysisStatus.Queued],
          },
        },
        {
          $set: {
            status: AnalysisStatus.Processing,
            startedAt: now,
            failureReason: null,
            'ingestStage.status': PipelineStageStatus.Running,
            'ingestStage.progress': 10,
            'ingestStage.updatedAt': now,
          },
          $inc: {
            'ingestStage.attempts': 1,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();

    if (!claimed) {
      const existing = await this.analysisModel
        .findOne({
          _id: analysisId,
          tenantId: job.data.tenantId,
        })
        .exec();
      if (
        existing?.ingestStage?.status === PipelineStageStatus.Completed &&
        existing.mediaMetadata
      ) {
        this.logger.debug(
          `ingest.already_completed analysisId=${job.data.analysisId}`,
        );
        await this.ensureScanQueued(
          analysisId,
          job.data.tenantId,
          job.data.objectKey,
        );
        return existing.mediaMetadata;
      }
      throw new Error('Analysis is not available for ingestion');
    }

    this.logger.log(
      `ingest.started analysisId=${job.data.analysisId} attempt=${job.attemptsMade + 1}`,
    );
    let mediaMetadata: MediaMetadata;
    try {
      const readUrl = await this.storage.createReadUrl(job.data.objectKey);
      mediaMetadata = await this.mediaProbe.probe(readUrl);
      this.logger.log(
        `ingest.probed analysisId=${job.data.analysisId} durationMs=${mediaMetadata.durationMs} format=${mediaMetadata.formatName}`,
      );
      const completedAt = new Date();
      await this.analysisModel
        .updateOne(
          {
            _id: analysisId,
            tenantId: job.data.tenantId,
          },
          {
            $set: {
              mediaMetadata,
              progress: 10,
              'ingestStage.status': PipelineStageStatus.Completed,
              'ingestStage.progress': 100,
              'ingestStage.updatedAt': completedAt,
              'scanStage.status': PipelineStageStatus.Queueing,
              'scanStage.progress': 0,
              'scanStage.updatedAt': completedAt,
            },
          },
        )
        .exec();
    } catch (error) {
      const attempts = job.opts.attempts ?? 1;
      const terminal = job.attemptsMade + 1 >= attempts;
      const failureReason =
        error instanceof Error ? error.message : 'Unknown ingestion error';
      await this.analysisModel
        .updateOne(
          {
            _id: analysisId,
            tenantId: job.data.tenantId,
          },
          {
            $set: {
              status: terminal
                ? AnalysisStatus.Failed
                : AnalysisStatus.Queued,
              failureReason,
              'ingestStage.status': terminal
                ? PipelineStageStatus.Failed
                : PipelineStageStatus.Pending,
              'ingestStage.updatedAt': new Date(),
            },
          },
        )
        .exec();
      const logMessage = `ingest.failed analysisId=${job.data.analysisId} terminal=${terminal} reason=${failureReason}`;
      if (terminal) {
        this.logger.error(logMessage);
      } else {
        this.logger.warn(logMessage);
      }
      throw error;
    }

    await this.ensureScanQueued(
      analysisId,
      job.data.tenantId,
      job.data.objectKey,
    );
    return mediaMetadata;
  }

  private async ensureScanQueued(
    analysisId: Types.ObjectId,
    tenantId: string,
    objectKey: string,
  ): Promise<void> {
    const document = await this.analysisModel
      .findOne({
        _id: analysisId,
        tenantId,
      })
      .exec();
    const stageStatus = document?.scanStage?.status;
    if (
      stageStatus === PipelineStageStatus.Completed ||
      stageStatus === PipelineStageStatus.Running
    ) {
      return;
    }

    if (
      stageStatus === PipelineStageStatus.Pending ||
      stageStatus === PipelineStageStatus.Failed ||
      !stageStatus
    ) {
      await this.analysisModel
        .updateOne(
          {
            _id: analysisId,
            tenantId,
          },
          {
            $set: {
              'scanStage.status': PipelineStageStatus.Queueing,
              'scanStage.progress': 0,
              'scanStage.updatedAt': new Date(),
            },
          },
        )
        .exec();
    }

    const scanJobId = `scan-${analysisId.toString()}`;
    await this.scanQueue.add(
      AUDIO_SCAN_JOB,
      {
        analysisId: analysisId.toString(),
        tenantId,
        objectKey,
      },
      {
        jobId: scanJobId,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 10_000,
        },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    this.logger.log(
      `scan.dispatched analysisId=${analysisId.toString()} queueJobId=${scanJobId}`,
    );
    await this.analysisModel
      .updateOne(
        {
          _id: analysisId,
          tenantId,
          'scanStage.status': PipelineStageStatus.Queueing,
        },
        {
          $set: {
            'scanStage.status': PipelineStageStatus.Queued,
            'scanStage.updatedAt': new Date(),
          },
        },
      )
      .exec();
  }
}
