import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job, Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import {
  CONTEXT_CLASSIFICATION_JOB,
  CONTEXT_CLASSIFICATION_QUEUE,
  ACOUSTIC_EVENT_JOB,
  ACOUSTIC_EVENT_QUEUE,
} from './analysis.constants';
import {
  ClassifyContextJob,
  ContextSummary,
  DetectAcousticEventsJob,
} from './analysis.types';
import {
  AnalysisJob,
  AnalysisStatus,
  PipelineStageStatus,
} from './schemas/analysis-job.schema';
import { ConversationSession } from './schemas/conversation-session.schema';
import { TimelineEvent } from './schemas/timeline-event.schema';
import { WorkerClientService } from './worker-client.service';

@Processor(CONTEXT_CLASSIFICATION_QUEUE, { concurrency: 2 })
export class ContextClassificationProcessor extends WorkerHost {
  private readonly logger = new Logger(ContextClassificationProcessor.name);

  constructor(
    @InjectModel(AnalysisJob.name)
    private readonly analysisModel: Model<AnalysisJob>,
    @InjectModel(ConversationSession.name)
    private readonly conversationModel: Model<ConversationSession>,
    @InjectModel(TimelineEvent.name)
    private readonly eventModel: Model<TimelineEvent>,
    @InjectQueue(ACOUSTIC_EVENT_QUEUE)
    private readonly acousticQueue: Queue<DetectAcousticEventsJob>,
    private readonly workerClient: WorkerClientService,
  ) {
    super();
  }

  async process(job: Job<ClassifyContextJob>): Promise<ContextSummary> {
    if (job.name !== CONTEXT_CLASSIFICATION_JOB) {
      throw new Error(`Unsupported context job: ${job.name}`);
    }
    const analysisJobId = new Types.ObjectId(job.data.analysisId);
    const claimed = await this.analysisModel
      .findOneAndUpdate(
        {
          _id: analysisJobId,
          tenantId: job.data.tenantId,
          'contextStage.status': {
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
            progress: 92,
            'contextStage.status': PipelineStageStatus.Running,
            'contextStage.progress': 10,
            'contextStage.updatedAt': new Date(),
            failureReason: null,
          },
          $inc: { 'contextStage.attempts': 1 },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!claimed) {
      const existing = await this.analysisModel.findById(analysisJobId).exec();
      if (
        existing?.contextStage?.status === PipelineStageStatus.Completed &&
        existing.contextSummary
      ) {
        if (
          existing.acousticStage?.status === PipelineStageStatus.Pending ||
          existing.acousticStage?.status === PipelineStageStatus.Queueing
        ) {
          await this.dispatchAcoustic(
            job.data.analysisId,
            job.data.tenantId,
            existing.sourceObjectKey,
            existing.contextStage.attempts,
          );
        }
        return existing.contextSummary;
      }
      throw new Error('Analysis is not available for context classification');
    }

    this.logger.log(`context.started analysisId=${job.data.analysisId}`);
    try {
      const conversations = await this.conversationModel
        .find({ analysisJobId, tenantId: job.data.tenantId })
        .sort({ sessionIndex: 1 })
        .lean()
        .exec();
      const response = await this.workerClient.classifyContext(
        job.data.analysisId,
        conversations.map((session) => ({
          sessionId: session._id.toString(),
          startMs: session.startMs,
          endMs: session.endMs,
          speakers: session.speakers,
          utterances: session.utterances.map((utterance) => ({
            startMs: utterance.startMs,
            endMs: utterance.endMs,
            speakerId: utterance.speakerId,
            text: utterance.text,
            confidence: utterance.confidence,
          })),
        })),
      );

      if (response.sessions.length > 0) {
        await this.conversationModel.bulkWrite(
          response.sessions.map((session) => ({
            updateOne: {
              filter: {
                _id: new Types.ObjectId(session.sessionId),
                analysisJobId,
                tenantId: job.data.tenantId,
              },
              update: {
                $set: {
                  quality: session.quality,
                  conversationType: session.conversationType,
                  profanity: session.profanity,
                  safetySignals: session.safetySignals,
                  contextModel: response.model,
                },
              },
            },
          })),
        );
      }

      await this.eventModel
        .deleteMany({ analysisJobId, tenantId: job.data.tenantId })
        .exec();
      const events = response.sessions.flatMap((session) =>
        session.safetySignals.map((signal) => ({
          analysisJobId,
          conversationSessionId: new Types.ObjectId(session.sessionId),
          tenantId: job.data.tenantId,
          startMs: signal.startMs,
          endMs: signal.endMs,
          eventType: signal.signalType,
          severity: signal.severity,
          confidence: signal.confidence,
          speakerId: signal.speakerId,
          evidence: signal.evidence,
          childInvolvement: 'unknown',
          modelName: response.model,
        })),
      );
      if (events.length > 0) {
        await this.eventModel.insertMany(events, { ordered: true });
      }

      const summary: ContextSummary = {
        model: response.model,
        processingSeconds: response.processingSeconds,
        sessionCount: response.sessions.length,
        usableSessionCount: response.sessions.filter(
          (session) => session.quality.usable,
        ).length,
        flaggedSessionCount: response.sessions.filter(
          (session) => session.safetySignals.length > 0,
        ).length,
        safetySignalCount: events.length,
        highSeverityCount: events.filter(
          (event) => event.severity === 'high',
        ).length,
        profanitySessionCount: response.sessions.filter(
          (session) => session.profanity.severity !== 'none',
        ).length,
        profanityOccurrenceCount: response.sessions.reduce(
          (total, session) =>
            total + session.profanity.occurrenceCount,
          0,
        ),
        profanityNotificationCount: response.sessions.filter(
          (session) => session.profanity.notificationRecommended,
        ).length,
      };
      await this.analysisModel
        .updateOne(
          { _id: analysisJobId, tenantId: job.data.tenantId },
          {
            $set: {
              status: AnalysisStatus.Processing,
              progress: 95,
              contextSummary: summary,
              'contextStage.status': PipelineStageStatus.Completed,
              'contextStage.progress': 100,
              'contextStage.updatedAt': new Date(),
              acousticStage: {
                status: PipelineStageStatus.Queueing,
                progress: 0,
                attempts: claimed.acousticStage?.attempts ?? 0,
                updatedAt: new Date(),
              },
              riskStage: {
                status: PipelineStageStatus.Pending,
                progress: 0,
                attempts: claimed.riskStage?.attempts ?? 0,
                updatedAt: new Date(),
              },
            },
            $unset: {
              acousticSummary: 1,
              riskSummary: 1,
              completedAt: 1,
            },
          },
        )
        .exec();
      await this.dispatchAcoustic(
        job.data.analysisId,
        job.data.tenantId,
        claimed.sourceObjectKey,
        claimed.contextStage.attempts,
      );
      this.logger.log(
        `context.completed analysisId=${job.data.analysisId} usableSessions=${summary.usableSessionCount} signals=${summary.safetySignalCount}`,
      );
      return summary;
    } catch (error) {
      await this.markFailure(job, analysisJobId, error);
      throw error;
    }
  }

  private async dispatchAcoustic(
    analysisId: string,
    tenantId: string,
    objectKey: string,
    contextAttempt: number,
  ): Promise<void> {
    await this.acousticQueue.add(
      ACOUSTIC_EVENT_JOB,
      { analysisId, tenantId, objectKey },
      {
        jobId: `acoustic-${analysisId}-context-${contextAttempt}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    await this.analysisModel
      .updateOne(
        {
          _id: new Types.ObjectId(analysisId),
          tenantId,
          'acousticStage.status': PipelineStageStatus.Queueing,
        },
        {
          $set: {
            'acousticStage.status': PipelineStageStatus.Queued,
            'acousticStage.updatedAt': new Date(),
          },
        },
      )
      .exec();
    this.logger.log(`acoustic.dispatched analysisId=${analysisId}`);
  }

  private async markFailure(
    job: Job<ClassifyContextJob>,
    analysisJobId: Types.ObjectId,
    error: unknown,
  ): Promise<void> {
    const terminal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const reason =
      error instanceof Error ? error.message : 'Unknown context error';
    await this.analysisModel
      .updateOne(
        { _id: analysisJobId, tenantId: job.data.tenantId },
        {
          $set: {
            status: terminal
              ? AnalysisStatus.Failed
              : AnalysisStatus.Processing,
            failureReason: reason,
            'contextStage.status': terminal
              ? PipelineStageStatus.Failed
              : PipelineStageStatus.Queued,
            'contextStage.updatedAt': new Date(),
          },
        },
      )
      .exec();
    const message = `context.failed analysisId=${job.data.analysisId} terminal=${terminal} reason=${reason}`;
    if (terminal) this.logger.error(message);
    else this.logger.warn(message);
  }
}
