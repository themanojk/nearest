import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job, Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { ObjectStorageService } from '../storage/storage.service';
import {
  ACOUSTIC_EVENT_JOB,
  ACOUSTIC_EVENT_QUEUE,
  RISK_AGGREGATION_JOB,
  RISK_AGGREGATION_QUEUE,
} from './analysis.constants';
import {
  AcousticSummary,
  DetectAcousticEventsJob,
  WorkerAcousticEvent,
  AggregateRiskJob,
} from './analysis.types';
import {
  AcousticEvent,
} from './schemas/acoustic-event.schema';
import {
  AnalysisJob,
  AnalysisStatus,
  PipelineStageStatus,
} from './schemas/analysis-job.schema';
import {
  TranscriptionChunk,
  TranscriptionChunkStatus,
} from './schemas/transcription-chunk.schema';
import { WorkerClientService } from './worker-client.service';

interface StoredAcousticEvent extends WorkerAcousticEvent {
  sourceChunkId: string;
  modelName: string;
}

@Processor(ACOUSTIC_EVENT_QUEUE, { concurrency: 1 })
export class AcousticEventProcessor extends WorkerHost {
  private readonly logger = new Logger(AcousticEventProcessor.name);

  constructor(
    @InjectModel(AnalysisJob.name)
    private readonly analysisModel: Model<AnalysisJob>,
    @InjectModel(TranscriptionChunk.name)
    private readonly transcriptionModel: Model<TranscriptionChunk>,
    @InjectModel(AcousticEvent.name)
    private readonly acousticEventModel: Model<AcousticEvent>,
    @InjectQueue(RISK_AGGREGATION_QUEUE)
    private readonly riskQueue: Queue<AggregateRiskJob>,
    private readonly storage: ObjectStorageService,
    private readonly workerClient: WorkerClientService,
  ) {
    super();
  }

  async process(job: Job<DetectAcousticEventsJob>): Promise<AcousticSummary> {
    if (job.name !== ACOUSTIC_EVENT_JOB) {
      throw new Error(`Unsupported acoustic-event job: ${job.name}`);
    }
    const analysisJobId = new Types.ObjectId(job.data.analysisId);
    const claimed = await this.analysisModel
      .findOneAndUpdate(
        {
          _id: analysisJobId,
          tenantId: job.data.tenantId,
          'acousticStage.status': {
            $in: [
              PipelineStageStatus.Pending,
              PipelineStageStatus.Queueing,
              PipelineStageStatus.Queued,
            ],
          },
        },
        {
          $set: {
            status: AnalysisStatus.Processing,
            progress: 96,
            'acousticStage.status': PipelineStageStatus.Running,
            'acousticStage.progress': 1,
            'acousticStage.updatedAt': new Date(),
            failureReason: null,
          },
          $inc: { 'acousticStage.attempts': 1 },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!claimed) {
      const existing = await this.analysisModel.findById(analysisJobId).exec();
      if (
        existing?.acousticStage?.status === PipelineStageStatus.Completed &&
        existing.acousticSummary
      ) {
        if (
          existing.riskStage?.status === PipelineStageStatus.Pending ||
          existing.riskStage?.status === PipelineStageStatus.Queueing
        ) {
          await this.dispatchRisk(
            job.data.analysisId,
            job.data.tenantId,
            existing.acousticStage.attempts,
          );
        }
        return existing.acousticSummary;
      }
      throw new Error(
        'Analysis is not available for acoustic-event detection',
      );
    }

    this.logger.log(`acoustic.started analysisId=${job.data.analysisId}`);
    try {
      const chunks = await this.transcriptionModel
        .find({
          analysisJobId,
          tenantId: job.data.tenantId,
          status: TranscriptionChunkStatus.Completed,
        })
        .sort({ chunkIndex: 1 })
        .select({ ranges: 1 })
        .lean()
        .exec();
      if (chunks.length === 0) {
        throw new Error('No completed processing chunks are available');
      }

      const sourceUrl = await this.storage.createReadUrl(job.data.objectKey);
      const detected: StoredAcousticEvent[] = [];
      let processingSeconds = 0;
      let windowCount = 0;
      let modelName = '';
      for (const [index, chunk] of chunks.entries()) {
        const chunkId = chunk._id.toString();
        const result = await this.workerClient.detectAcousticEvents(
          job.data.analysisId,
          chunkId,
          sourceUrl,
          chunk.ranges,
        );
        modelName = result.model;
        processingSeconds += result.processingSeconds;
        windowCount += result.windowCount;
        detected.push(
          ...result.events.map((event) => ({
            ...event,
            sourceChunkId: chunkId,
            modelName: result.model,
          })),
        );
        const progress = Math.max(
          1,
          Math.min(99, Math.round(((index + 1) / chunks.length) * 100)),
        );
        await this.analysisModel
          .updateOne(
            { _id: analysisJobId, tenantId: job.data.tenantId },
            {
              $set: {
                'acousticStage.progress': progress,
                'acousticStage.updatedAt': new Date(),
              },
            },
          )
          .exec();
        this.logger.log(
          `acoustic.progress analysisId=${job.data.analysisId} chunk=${index + 1}/${chunks.length} events=${detected.length}`,
        );
      }

      const events = mergeAcousticEvents(detected);
      await this.acousticEventModel
        .deleteMany({ analysisJobId, tenantId: job.data.tenantId })
        .exec();
      if (events.length > 0) {
        await this.acousticEventModel.insertMany(
          events.map((event) => ({
            ...event,
            analysisJobId,
            tenantId: job.data.tenantId,
          })),
          { ordered: true },
        );
      }

      const summary: AcousticSummary = {
        model: modelName,
        processingSeconds: Math.round(processingSeconds * 1000) / 1000,
        processedChunkCount: chunks.length,
        windowCount,
        eventCount: events.length,
        healthEventCount: events.filter(
          (event) => event.category === 'health_sound',
        ).length,
        coughEventCount: events.filter(
          (event) => event.label === 'Cough',
        ).length,
        wheezeEventCount: events.filter(
          (event) => event.label === 'Wheeze',
        ).length,
        gaspEventCount: events.filter(
          (event) => event.label === 'Gasp',
        ).length,
        highSeverityCount: events.filter(
          (event) => event.severity === 'high',
        ).length,
      };
      await this.analysisModel
        .updateOne(
          { _id: analysisJobId, tenantId: job.data.tenantId },
          {
            $set: {
              status: AnalysisStatus.Processing,
              progress: 98,
              acousticSummary: summary,
              'acousticStage.status': PipelineStageStatus.Completed,
              'acousticStage.progress': 100,
              'acousticStage.updatedAt': new Date(),
              riskStage: {
                status: PipelineStageStatus.Queueing,
                progress: 0,
                attempts: claimed.riskStage?.attempts ?? 0,
                updatedAt: new Date(),
              },
            },
            $unset: {
              riskSummary: 1,
              completedAt: 1,
            },
          },
        )
        .exec();
      await this.dispatchRisk(
        job.data.analysisId,
        job.data.tenantId,
        claimed.acousticStage.attempts,
      );
      this.logger.log(
        `acoustic.completed analysisId=${job.data.analysisId} windows=${windowCount} events=${events.length}`,
      );
      return summary;
    } catch (error) {
      await this.markFailure(job, analysisJobId, error);
      throw error;
    }
  }

  private async dispatchRisk(
    analysisId: string,
    tenantId: string,
    acousticAttempt: number,
  ): Promise<void> {
    await this.riskQueue.add(
      RISK_AGGREGATION_JOB,
      { analysisId, tenantId },
      {
        jobId: `risk-${analysisId}-acoustic-${acousticAttempt}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    await this.analysisModel
      .updateOne(
        {
          _id: new Types.ObjectId(analysisId),
          tenantId,
          'riskStage.status': PipelineStageStatus.Queueing,
        },
        {
          $set: {
            'riskStage.status': PipelineStageStatus.Queued,
            'riskStage.updatedAt': new Date(),
          },
        },
      )
      .exec();
    this.logger.log(`risk.dispatched analysisId=${analysisId}`);
  }

  private async markFailure(
    job: Job<DetectAcousticEventsJob>,
    analysisJobId: Types.ObjectId,
    error: unknown,
  ): Promise<void> {
    const terminal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const reason =
      error instanceof Error ? error.message : 'Unknown acoustic-event error';
    await this.analysisModel
      .updateOne(
        { _id: analysisJobId, tenantId: job.data.tenantId },
        {
          $set: {
            status: terminal
              ? AnalysisStatus.Failed
              : AnalysisStatus.Processing,
            failureReason: reason,
            'acousticStage.status': terminal
              ? PipelineStageStatus.Failed
              : PipelineStageStatus.Queued,
            'acousticStage.updatedAt': new Date(),
          },
        },
      )
      .exec();
    const message = `acoustic.failed analysisId=${job.data.analysisId} terminal=${terminal} reason=${reason}`;
    if (terminal) this.logger.error(message);
    else this.logger.warn(message);
  }
}

export function mergeAcousticEvents(
  input: StoredAcousticEvent[],
): StoredAcousticEvent[] {
  const events = [...input].sort(
    (left, right) =>
      left.label.localeCompare(right.label) ||
      left.startMs - right.startMs ||
      left.endMs - right.endMs,
  );
  const merged: StoredAcousticEvent[] = [];
  for (const event of events) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.label === event.label &&
      event.startMs <= previous.endMs + 1_000
    ) {
      previous.endMs = Math.max(previous.endMs, event.endMs);
      previous.confidence = Math.max(previous.confidence, event.confidence);
    } else {
      merged.push({ ...event });
    }
  }
  return merged.sort(
    (left, right) =>
      left.startMs - right.startMs || left.label.localeCompare(right.label),
  );
}
