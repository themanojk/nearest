import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Job, Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { ObjectStorageService } from '../storage/storage.service';
import {
  AUDIO_SCAN_JOB,
  AUDIO_SCAN_QUEUE,
  SPEECH_ASR_JOB,
  SPEECH_ASR_QUEUE,
} from './analysis.constants';
import {
  ScanAudioJob,
  ScanSummary,
  TranscribeAudioJob,
  WorkerScanResponse,
} from './analysis.types';
import { AsrChunkOptions, planAsrChunks } from './asr-chunk-planner';
import {
  AnalysisJob,
  AnalysisStatus,
  PipelineStageStatus,
  TranscriptionLanguageMode,
} from './schemas/analysis-job.schema';
import {
  createProcessingRegions,
  LogicalTrimmingOptions,
  ProcessingRegion,
} from './logical-trimming';
import {
  ScanSegment,
  ScanSegmentType,
} from './schemas/scan-segment.schema';
import { WorkerClientService } from './worker-client.service';
import {
  TranscriptionChunk,
  TranscriptionChunkStatus,
} from './schemas/transcription-chunk.schema';

@Processor(AUDIO_SCAN_QUEUE, { concurrency: 1 })
export class AudioScanProcessor extends WorkerHost {
  private readonly logger = new Logger(AudioScanProcessor.name);
  private readonly asrChunkOptions: AsrChunkOptions;
  private readonly trimmingOptions: LogicalTrimmingOptions;

  constructor(
    @InjectModel(AnalysisJob.name)
    private readonly analysisModel: Model<AnalysisJob>,
    @InjectModel(ScanSegment.name)
    private readonly segmentModel: Model<ScanSegment>,
    @InjectModel(TranscriptionChunk.name)
    private readonly transcriptionModel: Model<TranscriptionChunk>,
    @InjectQueue(SPEECH_ASR_QUEUE)
    private readonly asrQueue: Queue<TranscribeAudioJob>,
    private readonly storage: ObjectStorageService,
    private readonly workerClient: WorkerClientService,
    config: ConfigService,
  ) {
    super();
    this.trimmingOptions = {
      contextAfterMs: config.getOrThrow<number>(
        'LOGICAL_TRIM_CONTEXT_AFTER_MS',
      ),
      contextBeforeMs: config.getOrThrow<number>(
        'LOGICAL_TRIM_CONTEXT_BEFORE_MS',
      ),
      maxGapMs: config.getOrThrow<number>('LOGICAL_TRIM_MAX_GAP_MS'),
      minRegionMs: config.getOrThrow<number>('LOGICAL_TRIM_MIN_REGION_MS'),
    };
    this.asrChunkOptions = {
      maxChunkMs: config.getOrThrow<number>('ASR_MAX_CHUNK_MS'),
    };
  }

  async process(job: Job<ScanAudioJob>): Promise<ScanSummary> {
    if (job.name !== AUDIO_SCAN_JOB) {
      throw new Error(`Unsupported scan job: ${job.name}`);
    }

    const analysisId = new Types.ObjectId(job.data.analysisId);
    const claimed = await this.analysisModel
      .findOneAndUpdate(
        {
          _id: analysisId,
          tenantId: job.data.tenantId,
          'scanStage.status': {
            $in: [
              PipelineStageStatus.Queueing,
              PipelineStageStatus.Queued,
            ],
          },
        },
        {
          $set: {
            'scanStage.status': PipelineStageStatus.Running,
            'scanStage.progress': 10,
            'scanStage.updatedAt': new Date(),
            failureReason: null,
          },
          $inc: {
            'scanStage.attempts': 1,
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
        existing?.scanStage?.status === PipelineStageStatus.Completed &&
        existing.scanSummary
      ) {
        this.logger.debug(
          `scan.already_completed analysisId=${job.data.analysisId}`,
        );
        return existing.scanSummary;
      }
      throw new Error('Analysis is not available for Tier-1 scanning');
    }

    this.logger.log(
      `scan.started analysisId=${job.data.analysisId} attempt=${job.attemptsMade + 1}`,
    );
    try {
      const sourceUrl = await this.storage.createReadUrl(job.data.objectKey);
      const result = await this.workerClient.scanAudio(
        job.data.analysisId,
        sourceUrl,
      );
      this.logger.log(
        `scan.worker_completed analysisId=${job.data.analysisId} windows=${result.windows.length} speechIntervals=${result.speechIntervals.length} speechRatio=${result.summary.speechRatio}`,
      );
      const processingRegions = createProcessingRegions(
        result.speechIntervals,
        result.summary.decodedDurationMs,
        this.trimmingOptions,
      );
      const retainedDurationMs = processingRegions.reduce(
        (total, region) => total + region.endMs - region.startMs,
        0,
      );
      const asrChunks = planAsrChunks(
        processingRegions,
        this.asrChunkOptions,
        result.summary.decodedDurationMs,
      );
      await this.persistSegments(
        analysisId,
        job.data.tenantId,
        result,
        processingRegions,
      );
      const transcriptionChunks = await this.persistTranscriptionChunks(
        analysisId,
        job.data.tenantId,
        asrChunks,
      );

      const scanSummary: ScanSummary = {
        ...result.summary,
        pipelineVersion: result.pipelineVersion,
        processingRegionCount: processingRegions.length,
        removedSilenceDurationMs: Math.max(
          0,
          result.summary.decodedDurationMs - retainedDurationMs,
        ),
        retainedDurationMs,
        retainedRatio:
          result.summary.decodedDurationMs > 0
            ? retainedDurationMs / result.summary.decodedDurationMs
            : 0,
      };
      await this.analysisModel
        .updateOne(
          {
            _id: analysisId,
            tenantId: job.data.tenantId,
          },
          {
            $set: {
              progress: 25,
              status:
                transcriptionChunks.length === 0
                  ? AnalysisStatus.Completed
                  : AnalysisStatus.Processing,
              scanSummary,
              'scanStage.status': PipelineStageStatus.Completed,
              'scanStage.progress': 100,
              'scanStage.updatedAt': new Date(),
              'transcriptionStage.status':
                transcriptionChunks.length === 0
                  ? PipelineStageStatus.Completed
                  : PipelineStageStatus.Queueing,
              'transcriptionStage.progress':
                transcriptionChunks.length === 0 ? 100 : 0,
              'transcriptionStage.updatedAt': new Date(),
              transcriptionSummary: {
                chunkCount: transcriptionChunks.length,
                completedChunkCount: 0,
                failedChunkCount: 0,
                transcribedDurationMs: 0,
                wordCount: 0,
              },
              ...(transcriptionChunks.length === 0
                ? {
                    'diarizationStage.status':
                      PipelineStageStatus.Completed,
                    'diarizationStage.progress': 100,
                    'conversationStage.status':
                      PipelineStageStatus.Completed,
                    'conversationStage.progress': 100,
                    diarizationSummary: {
                      model: 'not-required',
                      speakerCount: 0,
                      turnCount: 0,
                      processingSeconds: 0,
                    },
                    conversationSummary: {
                      sessionCount: 0,
                      utteranceCount: 0,
                    },
                    'contextStage.status':
                      PipelineStageStatus.Completed,
                    'contextStage.progress': 100,
                    contextSummary: {
                      model: 'not-required',
                      processingSeconds: 0,
                      sessionCount: 0,
                      usableSessionCount: 0,
                      flaggedSessionCount: 0,
                      safetySignalCount: 0,
                      highSeverityCount: 0,
                      profanitySessionCount: 0,
                    },
                  }
                : {}),
              ...(transcriptionChunks.length === 0
                ? { completedAt: new Date(), progress: 100 }
                : {}),
            },
          },
        )
        .exec();
      if (transcriptionChunks.length > 0) {
        await this.dispatchTranscriptionChunks(
          job.data,
          transcriptionChunks,
          claimed.transcriptionLanguageMode ??
            TranscriptionLanguageMode.Auto,
        );
      }
      this.logger.log(
        `scan.completed analysisId=${job.data.analysisId} pipelineVersion=${result.pipelineVersion} processingRegions=${processingRegions.length} retainedDurationMs=${retainedDurationMs}`,
      );
      return scanSummary;
    } catch (error) {
      await this.markFailure(job, analysisId, error);
      throw error;
    }
  }

  private async persistTranscriptionChunks(
    analysisId: Types.ObjectId,
    tenantId: string,
    chunks: Array<{
      durationMs: number;
      endMs: number;
      ranges: Array<{ endMs: number; startMs: number }>;
      sourceRegionCount: number;
      startMs: number;
    }>,
  ): Promise<
    Array<{
      _id: Types.ObjectId;
      durationMs: number;
      endMs: number;
      ranges: Array<{ endMs: number; startMs: number }>;
      startMs: number;
    }>
  > {
    await this.transcriptionModel
      .deleteMany({ analysisJobId: analysisId, tenantId })
      .exec();
    const documents = chunks.map((chunk, chunkIndex) => ({
      _id: new Types.ObjectId(),
      analysisJobId: analysisId,
      tenantId,
      chunkIndex,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      durationMs: chunk.durationMs,
      ranges: chunk.ranges,
      sourceRegionCount: chunk.sourceRegionCount,
      status: TranscriptionChunkStatus.Pending,
      attempts: 0,
    }));
    if (documents.length > 0) {
      await this.transcriptionModel.insertMany(documents, { ordered: true });
    }
    return documents;
  }

  private async dispatchTranscriptionChunks(
    scanJob: ScanAudioJob,
    chunks: Array<{
      _id: Types.ObjectId;
      endMs: number;
      ranges: Array<{ endMs: number; startMs: number }>;
      startMs: number;
    }>,
    transcriptionLanguageMode: TranscriptionLanguageMode,
  ): Promise<void> {
    await this.asrQueue.addBulk(
      chunks.map((chunk) => ({
        name: SPEECH_ASR_JOB,
        data: {
          analysisId: scanJob.analysisId,
          chunkId: chunk._id.toString(),
          tenantId: scanJob.tenantId,
          objectKey: scanJob.objectKey,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          ranges: chunk.ranges,
          transcriptionLanguageMode,
        },
        opts: {
          jobId: `asr-${scanJob.analysisId}-${chunk._id.toString()}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 15_000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      })),
    );
    await Promise.all([
      this.transcriptionModel
        .updateMany(
          {
            analysisJobId: new Types.ObjectId(scanJob.analysisId),
            tenantId: scanJob.tenantId,
            status: TranscriptionChunkStatus.Pending,
          },
          { $set: { status: TranscriptionChunkStatus.Queued } },
        )
        .exec(),
      this.analysisModel
        .updateOne(
          {
            _id: new Types.ObjectId(scanJob.analysisId),
            tenantId: scanJob.tenantId,
          },
          {
            $set: {
              progress: 30,
              'transcriptionStage.status': PipelineStageStatus.Queued,
              'transcriptionStage.updatedAt': new Date(),
            },
          },
        )
        .exec(),
    ]);
    this.logger.log(
      `transcription.dispatched analysisId=${scanJob.analysisId} chunks=${chunks.length}`,
    );
  }

  private async persistSegments(
    analysisId: Types.ObjectId,
    tenantId: string,
    result: WorkerScanResponse,
    processingRegions: ProcessingRegion[],
  ): Promise<void> {
    await this.segmentModel
      .deleteMany({
        analysisJobId: analysisId,
        tenantId,
      })
      .exec();

    const segments = [
      ...result.windows.map((window) => ({
        analysisJobId: analysisId,
        tenantId,
        segmentType: ScanSegmentType.Window,
        startMs: window.startMs,
        endMs: window.endMs,
        speechRatio: window.speechRatio,
        rmsDbfs: window.rmsDbfs,
        peakDbfs: window.peakDbfs,
        labels: window.labels,
        needsAsr: window.speechRatio >= 0.2,
      })),
      ...result.speechIntervals.map((interval) => ({
        analysisJobId: analysisId,
        tenantId,
        segmentType: ScanSegmentType.Speech,
        startMs: interval.startMs,
        endMs: interval.endMs,
        confidence: interval.confidence,
        labels: ['speech_candidate'],
        needsAsr: true,
      })),
      ...processingRegions.map((region) => ({
        analysisJobId: analysisId,
        tenantId,
        segmentType: ScanSegmentType.ProcessingRegion,
        startMs: region.startMs,
        endMs: region.endMs,
        labels: ['logical_trimmed', 'asr_ready'],
        needsAsr: true,
        sourceIntervalCount: region.sourceIntervalCount,
      })),
    ];

    if (segments.length > 0) {
      await this.segmentModel.insertMany(segments, {
        ordered: true,
      });
    }
  }

  private async markFailure(
    job: Job<ScanAudioJob>,
    analysisId: Types.ObjectId,
    error: unknown,
  ): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    const terminal = job.attemptsMade + 1 >= attempts;
    const failureReason =
      error instanceof Error ? error.message : 'Unknown scan error';
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
              : AnalysisStatus.Processing,
            failureReason,
            'scanStage.status': terminal
              ? PipelineStageStatus.Failed
              : PipelineStageStatus.Pending,
            'scanStage.updatedAt': new Date(),
          },
        },
      )
      .exec();
    const logMessage = `scan.failed analysisId=${job.data.analysisId} terminal=${terminal} reason=${failureReason}`;
    if (terminal) {
      this.logger.error(logMessage);
    } else {
      this.logger.warn(logMessage);
    }
  }
}
