import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job, Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { ObjectStorageService } from '../storage/storage.service';
import {
  SPEECH_ASR_JOB,
  SPEECH_ASR_QUEUE,
  SPEECH_DIARIZATION_JOB,
  SPEECH_DIARIZATION_QUEUE,
} from './analysis.constants';
import {
  DiarizeAudioJob,
  TranscribeAudioJob,
  TranscriptionSummary,
} from './analysis.types';
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

const configuredConcurrency = Number(process.env.ASR_QUEUE_CONCURRENCY ?? 2);
const asrQueueConcurrency =
  Number.isInteger(configuredConcurrency) && configuredConcurrency > 0
    ? configuredConcurrency
    : 2;

@Processor(SPEECH_ASR_QUEUE, { concurrency: asrQueueConcurrency })
export class SpeechAsrProcessor extends WorkerHost {
  private readonly logger = new Logger(SpeechAsrProcessor.name);

  constructor(
    @InjectModel(AnalysisJob.name)
    private readonly analysisModel: Model<AnalysisJob>,
    @InjectModel(TranscriptionChunk.name)
    private readonly transcriptionModel: Model<TranscriptionChunk>,
    @InjectQueue(SPEECH_DIARIZATION_QUEUE)
    private readonly diarizationQueue: Queue<DiarizeAudioJob>,
    private readonly storage: ObjectStorageService,
    private readonly workerClient: WorkerClientService,
  ) {
    super();
  }

  async process(job: Job<TranscribeAudioJob>): Promise<void> {
    if (job.name !== SPEECH_ASR_JOB) {
      throw new Error(`Unsupported transcription job: ${job.name}`);
    }
    const chunkId = new Types.ObjectId(job.data.chunkId);
    const claimed = await this.transcriptionModel
      .findOneAndUpdate(
        {
          _id: chunkId,
          tenantId: job.data.tenantId,
          status: {
            $in: [
              TranscriptionChunkStatus.Pending,
              TranscriptionChunkStatus.Queued,
              TranscriptionChunkStatus.Running,
            ],
          },
        },
        {
          $set: {
            status: TranscriptionChunkStatus.Running,
            failureReason: null,
          },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!claimed) {
      const existing = await this.transcriptionModel
        .findById(chunkId)
        .exec();
      if (existing?.status === TranscriptionChunkStatus.Completed) return;
      throw new Error('Transcription chunk is not available');
    }

    await this.analysisModel
      .updateOne(
        {
          _id: new Types.ObjectId(job.data.analysisId),
          tenantId: job.data.tenantId,
        },
        {
          $set: {
            'transcriptionStage.status': PipelineStageStatus.Running,
            'transcriptionStage.updatedAt': new Date(),
          },
        },
      )
      .exec();
    this.logger.log(
      `transcription.started analysisId=${job.data.analysisId} chunkId=${job.data.chunkId} startMs=${job.data.startMs} endMs=${job.data.endMs}`,
    );

    try {
      const sourceUrl = await this.storage.createReadUrl(job.data.objectKey);
      const result = await this.workerClient.transcribeAudio(
        job.data.analysisId,
        job.data.chunkId,
        sourceUrl,
        job.data.startMs,
        job.data.endMs,
        job.data.ranges,
        job.data.transcriptionLanguageMode,
      );
      await this.transcriptionModel
        .updateOne(
          { _id: chunkId, tenantId: job.data.tenantId },
          {
            $set: {
              status: TranscriptionChunkStatus.Completed,
              text: result.text,
              language: result.language,
              languageMode: result.languageMode,
              languageProbability: result.languageProbability,
              modelName: result.model,
              processingSeconds: result.processingSeconds,
              extractionSeconds: result.extractionSeconds,
              inferenceSeconds: result.inferenceSeconds,
              audioDurationSeconds: result.audioDurationSeconds,
              audioDurationAfterVadSeconds:
                result.audioDurationAfterVadSeconds,
              vadFallbackUsed: result.vadFallbackUsed,
              qualityRetryUsed: result.qualityRetryUsed,
              words: result.words,
              failureReason: null,
            },
          },
        )
        .exec();
      await this.refreshAnalysisProgress(job.data);
      this.logger.log(
        `transcription.completed analysisId=${job.data.analysisId} chunkId=${job.data.chunkId} language=${result.language ?? 'unknown'} languageMode=${result.languageMode} qualityRetry=${result.qualityRetryUsed} words=${result.words.length} extractionSeconds=${result.extractionSeconds} inferenceSeconds=${result.inferenceSeconds} audioAfterVadSeconds=${result.audioDurationAfterVadSeconds ?? 'unknown'}`,
      );
    } catch (error) {
      await this.markFailure(job, error);
      throw error;
    }
  }

  private async refreshAnalysisProgress(
    data: TranscribeAudioJob,
  ): Promise<void> {
    const analysisJobId = new Types.ObjectId(data.analysisId);
    const filter = { analysisJobId, tenantId: data.tenantId };
    const [chunkCount, completedChunkCount, failedChunkCount, totals] =
      await Promise.all([
        this.transcriptionModel.countDocuments(filter).exec(),
        this.transcriptionModel
          .countDocuments({
            ...filter,
            status: TranscriptionChunkStatus.Completed,
          })
          .exec(),
        this.transcriptionModel
          .countDocuments({
            ...filter,
            status: TranscriptionChunkStatus.Failed,
          })
          .exec(),
        this.transcriptionModel
          .aggregate<{
            transcribedDurationMs: number;
            wordCount: number;
          }>([
            {
              $match: {
                ...filter,
                status: TranscriptionChunkStatus.Completed,
              },
            },
            {
              $group: {
                _id: null,
                transcribedDurationMs: {
                  $sum: '$durationMs',
                },
                wordCount: {
                  $sum: { $size: { $ifNull: ['$words', []] } },
                },
              },
            },
          ])
          .exec(),
      ]);
    const summary: TranscriptionSummary = {
      chunkCount,
      completedChunkCount,
      failedChunkCount,
      transcribedDurationMs: totals[0]?.transcribedDurationMs ?? 0,
      wordCount: totals[0]?.wordCount ?? 0,
    };
    const finished = completedChunkCount + failedChunkCount === chunkCount;
    const failed = finished && failedChunkCount > 0;
    const progress =
      chunkCount > 0
        ? Math.round((completedChunkCount / chunkCount) * 100)
        : 100;
    await this.analysisModel
      .updateOne(
        { _id: analysisJobId, tenantId: data.tenantId },
        {
          $set: {
            transcriptionSummary: summary,
            progress: finished ? 75 : 30 + Math.round(progress * 0.45),
            status: failed
              ? AnalysisStatus.Failed
              : finished
                ? AnalysisStatus.Processing
                : AnalysisStatus.Processing,
            'transcriptionStage.status': failed
              ? PipelineStageStatus.Failed
              : finished
                ? PipelineStageStatus.Completed
                : PipelineStageStatus.Running,
            'transcriptionStage.progress': progress,
            'transcriptionStage.updatedAt': new Date(),
            ...(finished && !failed
              ? {
                  'diarizationStage.status': PipelineStageStatus.Queueing,
                  'diarizationStage.updatedAt': new Date(),
                }
              : {}),
          },
        },
      )
      .exec();
    if (finished && !failed) {
      await this.dispatchDiarization(data);
    }
  }

  private async dispatchDiarization(data: TranscribeAudioJob): Promise<void> {
    const analysisJobId = new Types.ObjectId(data.analysisId);
    const claimed = await this.analysisModel
      .findOneAndUpdate(
        {
          _id: analysisJobId,
          tenantId: data.tenantId,
          'diarizationStage.status': PipelineStageStatus.Queueing,
        },
        {
          $set: {
            'diarizationStage.status': PipelineStageStatus.Queued,
            'diarizationStage.updatedAt': new Date(),
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!claimed) return;
    await this.diarizationQueue.add(
      SPEECH_DIARIZATION_JOB,
      {
        analysisId: data.analysisId,
        tenantId: data.tenantId,
        objectKey: data.objectKey,
      },
      {
        jobId: `diarize-${data.analysisId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 15_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    this.logger.log(`diarization.dispatched analysisId=${data.analysisId}`);
  }

  private async markFailure(
    job: Job<TranscribeAudioJob>,
    error: unknown,
  ): Promise<void> {
    const terminal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const reason =
      error instanceof Error ? error.message : 'Unknown transcription error';
    await this.transcriptionModel
      .updateOne(
        {
          _id: new Types.ObjectId(job.data.chunkId),
          tenantId: job.data.tenantId,
        },
        {
          $set: {
            status: terminal
              ? TranscriptionChunkStatus.Failed
              : TranscriptionChunkStatus.Queued,
            failureReason: reason,
          },
        },
      )
      .exec();
    if (terminal) await this.refreshAnalysisProgress(job.data);
    const message = `transcription.failed analysisId=${job.data.analysisId} chunkId=${job.data.chunkId} terminal=${terminal} reason=${reason}`;
    if (terminal) this.logger.error(message);
    else this.logger.warn(message);
  }
}
