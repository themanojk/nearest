import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job, Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { ObjectStorageService } from '../storage/storage.service';
import {
  SPEECH_DIARIZATION_JOB,
  SPEECH_DIARIZATION_QUEUE,
  CONTEXT_CLASSIFICATION_JOB,
  CONTEXT_CLASSIFICATION_QUEUE,
} from './analysis.constants';
import {
  DiarizationSummary,
  DiarizeAudioJob,
  ClassifyContextJob,
} from './analysis.types';
import { buildConversationSessions } from './conversation-builder';
import {
  AnalysisJob,
  AnalysisStatus,
  PipelineStageStatus,
} from './schemas/analysis-job.schema';
import {
  ConversationSession,
} from './schemas/conversation-session.schema';
import { SpeakerTurn } from './schemas/speaker-turn.schema';
import {
  TranscriptionChunk,
  TranscriptionChunkStatus,
} from './schemas/transcription-chunk.schema';
import { WorkerClientService } from './worker-client.service';

@Processor(SPEECH_DIARIZATION_QUEUE, { concurrency: 1 })
export class SpeechDiarizationProcessor extends WorkerHost {
  private readonly logger = new Logger(SpeechDiarizationProcessor.name);

  constructor(
    @InjectModel(AnalysisJob.name)
    private readonly analysisModel: Model<AnalysisJob>,
    @InjectModel(TranscriptionChunk.name)
    private readonly transcriptionModel: Model<TranscriptionChunk>,
    @InjectModel(SpeakerTurn.name)
    private readonly speakerTurnModel: Model<SpeakerTurn>,
    @InjectModel(ConversationSession.name)
    private readonly conversationModel: Model<ConversationSession>,
    @InjectQueue(CONTEXT_CLASSIFICATION_QUEUE)
    private readonly contextQueue: Queue<ClassifyContextJob>,
    private readonly storage: ObjectStorageService,
    private readonly workerClient: WorkerClientService,
  ) {
    super();
  }

  async process(job: Job<DiarizeAudioJob>): Promise<DiarizationSummary> {
    if (job.name !== SPEECH_DIARIZATION_JOB) {
      throw new Error(`Unsupported diarization job: ${job.name}`);
    }
    const analysisJobId = new Types.ObjectId(job.data.analysisId);
    const claimed = await this.analysisModel
      .findOneAndUpdate(
        {
          _id: analysisJobId,
          tenantId: job.data.tenantId,
          'diarizationStage.status': {
            $in: [
              PipelineStageStatus.Queueing,
              PipelineStageStatus.Queued,
              PipelineStageStatus.Pending,
            ],
          },
        },
        {
          $set: {
            status: AnalysisStatus.Processing,
            progress: 78,
            'diarizationStage.status': PipelineStageStatus.Running,
            'diarizationStage.progress': 10,
            'diarizationStage.updatedAt': new Date(),
            failureReason: null,
          },
          $inc: { 'diarizationStage.attempts': 1 },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!claimed) {
      const existing = await this.analysisModel
        .findById(analysisJobId)
        .exec();
      if (
        existing?.diarizationStage?.status === PipelineStageStatus.Completed &&
        existing.diarizationSummary
      ) {
        if (
          existing.contextStage?.status === PipelineStageStatus.Pending ||
          existing.contextStage?.status === PipelineStageStatus.Queueing
        ) {
          await this.dispatchContext(
            job.data.analysisId,
            job.data.tenantId,
            existing.diarizationStage.attempts,
          );
        }
        return existing.diarizationSummary;
      }
      throw new Error('Analysis is not available for diarization');
    }

    this.logger.log(
      `diarization.started analysisId=${job.data.analysisId}`,
    );
    try {
      const chunks = await this.transcriptionModel
        .find({
          analysisJobId,
          tenantId: job.data.tenantId,
          status: TranscriptionChunkStatus.Completed,
        })
        .sort({ chunkIndex: 1 })
        .select({ words: 1 })
        .lean()
        .exec();
      const words = chunks
        .flatMap((chunk) => chunk.words ?? [])
        .filter(
          (word) =>
            word.text.trim().length > 0 && word.endMs > word.startMs,
        )
        .sort(
          (left, right) =>
            left.startMs - right.startMs || left.endMs - right.endMs,
        )
        .map((word) => ({
          startMs: word.startMs,
          endMs: word.endMs,
          text: word.text,
        }));
      const sourceUrl = await this.storage.createReadUrl(job.data.objectKey);
      const result = await this.workerClient.diarizeAudio(
        job.data.analysisId,
        sourceUrl,
        words,
      );
      const turns = result.turns.map((turn, turnIndex) => ({
        ...turn,
        turnIndex,
        analysisJobId,
        tenantId: job.data.tenantId,
        model: result.model,
      }));
      const sessions = buildConversationSessions(result.turns);

      await Promise.all([
        this.speakerTurnModel
          .deleteMany({ analysisJobId, tenantId: job.data.tenantId })
          .exec(),
        this.conversationModel
          .deleteMany({ analysisJobId, tenantId: job.data.tenantId })
          .exec(),
      ]);
      if (turns.length > 0) {
        await this.speakerTurnModel.insertMany(turns, { ordered: true });
      }
      if (sessions.length > 0) {
        await this.conversationModel.insertMany(
          sessions.map((session) => ({
            ...session,
            analysisJobId,
            tenantId: job.data.tenantId,
            environment: 'unknown',
            childPresent: false,
          })),
          { ordered: true },
        );
      }

      const summary: DiarizationSummary = {
        model: result.model,
        processingSeconds: result.processingSeconds,
        speakerCount: result.speakerCount,
        turnCount: result.turns.length,
      };
      await this.analysisModel
        .updateOne(
          { _id: analysisJobId, tenantId: job.data.tenantId },
          {
            $set: {
              status: AnalysisStatus.Processing,
              progress: 90,
              diarizationSummary: summary,
              conversationSummary: {
                sessionCount: sessions.length,
                utteranceCount: result.turns.length,
              },
              'diarizationStage.status': PipelineStageStatus.Completed,
              'diarizationStage.progress': 100,
              'diarizationStage.updatedAt': new Date(),
              'conversationStage.status': PipelineStageStatus.Completed,
              'conversationStage.progress': 100,
              'conversationStage.updatedAt': new Date(),
              contextStage: {
                status: PipelineStageStatus.Queueing,
                progress: 0,
                attempts: claimed.contextStage?.attempts ?? 0,
                updatedAt: new Date(),
              },
              acousticStage: {
                status: PipelineStageStatus.Pending,
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
              contextSummary: 1,
              acousticSummary: 1,
              riskSummary: 1,
              completedAt: 1,
            },
          },
        )
        .exec();
      await this.dispatchContext(
        job.data.analysisId,
        job.data.tenantId,
        claimed.diarizationStage.attempts,
      );
      this.logger.log(
        `diarization.completed analysisId=${job.data.analysisId} speakers=${summary.speakerCount} turns=${summary.turnCount} sessions=${sessions.length}`,
      );
      return summary;
    } catch (error) {
      await this.markFailure(job, analysisJobId, error);
      throw error;
    }
  }

  private async dispatchContext(
    analysisId: string,
    tenantId: string,
    diarizationAttempt: number,
  ): Promise<void> {
    await this.contextQueue.add(
      CONTEXT_CLASSIFICATION_JOB,
      { analysisId, tenantId },
      {
        jobId: `context-${analysisId}-diarization-${diarizationAttempt}`,
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
          'contextStage.status': PipelineStageStatus.Queueing,
        },
        {
          $set: {
            'contextStage.status': PipelineStageStatus.Queued,
            'contextStage.updatedAt': new Date(),
          },
        },
      )
      .exec();
    this.logger.log(`context.dispatched analysisId=${analysisId}`);
  }

  private async markFailure(
    job: Job<DiarizeAudioJob>,
    analysisJobId: Types.ObjectId,
    error: unknown,
  ): Promise<void> {
    const terminal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const reason =
      error instanceof Error ? error.message : 'Unknown diarization error';
    await this.analysisModel
      .updateOne(
        { _id: analysisJobId, tenantId: job.data.tenantId },
        {
          $set: {
            status: terminal
              ? AnalysisStatus.Failed
              : AnalysisStatus.Processing,
            failureReason: reason,
            'diarizationStage.status': terminal
              ? PipelineStageStatus.Failed
              : PipelineStageStatus.Queued,
            'diarizationStage.updatedAt': new Date(),
          },
        },
      )
      .exec();
    const message = `diarization.failed analysisId=${job.data.analysisId} terminal=${terminal} reason=${reason}`;
    if (terminal) this.logger.error(message);
    else this.logger.warn(message);
  }
}
