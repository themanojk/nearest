import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { ObjectStorageService } from '../storage/storage.service';
import {
  AUDIO_INGEST_JOB,
  AUDIO_INGEST_QUEUE,
  CONTEXT_CLASSIFICATION_JOB,
  CONTEXT_CLASSIFICATION_QUEUE,
  SPEECH_DIARIZATION_JOB,
  SPEECH_DIARIZATION_QUEUE,
  ACOUSTIC_EVENT_JOB,
  ACOUSTIC_EVENT_QUEUE,
  RISK_AGGREGATION_JOB,
  RISK_AGGREGATION_QUEUE,
} from './analysis.constants';
import {
  AnalysisResponse,
  AnalysisPageResponse,
  AudioPlaybackResponse,
  ClassifyContextJob,
  ConversationPageResponse,
  CreateAnalysisResponse,
  IngestAudioJob,
  DiarizeAudioJob,
  SegmentPageResponse,
  SegmentResponse,
  TranscriptionChunkResponse,
  TranscriptionPageResponse,
  TimelineEventPageResponse,
  AcousticEventPageResponse,
  DetectAcousticEventsJob,
  AggregateRiskJob,
  RiskIncidentPageResponse,
  MultipartPartsResponse,
  MultipartUploadStatusResponse,
} from './analysis.types';
import { CreateAnalysisDto } from './dto/create-analysis.dto';
import { ListAnalysesDto } from './dto/list-analyses.dto';
import { ListSegmentsDto } from './dto/list-segments.dto';
import { ListTranscriptionsDto } from './dto/list-transcriptions.dto';
import { StartDiarizationDto } from './dto/start-diarization.dto';
import { StartContextClassificationDto } from './dto/start-context-classification.dto';
import { StartAcousticDetectionDto } from './dto/start-acoustic-detection.dto';
import { StartRiskAggregationDto } from './dto/start-risk-aggregation.dto';
import {
  AnalysisJob,
  AnalysisJobDocument,
  AnalysisStatus,
  AudioUploadMode,
  PipelineStageStatus,
  TranscriptionLanguageMode,
} from './schemas/analysis-job.schema';
import { CreateMultipartPartsDto } from './dto/create-multipart-parts.dto';
import {
  ScanSegment,
  ScanSegmentDocument,
} from './schemas/scan-segment.schema';
import {
  TranscriptionChunk,
  TranscriptionChunkDocument,
} from './schemas/transcription-chunk.schema';
import {
  ConversationSession,
  ConversationSessionDocument,
} from './schemas/conversation-session.schema';
import {
  TimelineEvent,
  TimelineEventDocument,
} from './schemas/timeline-event.schema';
import {
  AcousticEvent,
  AcousticEventDocument,
} from './schemas/acoustic-event.schema';
import {
  RiskIncident,
  RiskIncidentDocument,
} from './schemas/risk-incident.schema';

const MULTIPART_PART_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_PARTS = 10_000;

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private readonly maxAudioSizeBytes: number;

  constructor(
    @InjectModel(AnalysisJob.name)
    private readonly analysisModel: Model<AnalysisJob>,
    @InjectModel(ScanSegment.name)
    private readonly segmentModel: Model<ScanSegment>,
    @InjectModel(TranscriptionChunk.name)
    private readonly transcriptionModel: Model<TranscriptionChunk>,
    @InjectModel(ConversationSession.name)
    private readonly conversationModel: Model<ConversationSession>,
    @InjectModel(TimelineEvent.name)
    private readonly eventModel: Model<TimelineEvent>,
    @InjectModel(AcousticEvent.name)
    private readonly acousticEventModel: Model<AcousticEvent>,
    @InjectModel(RiskIncident.name)
    private readonly riskIncidentModel: Model<RiskIncident>,
    @InjectQueue(AUDIO_INGEST_QUEUE)
    private readonly ingestQueue: Queue<IngestAudioJob>,
    @InjectQueue(SPEECH_DIARIZATION_QUEUE)
    private readonly diarizationQueue: Queue<DiarizeAudioJob>,
    @InjectQueue(CONTEXT_CLASSIFICATION_QUEUE)
    private readonly contextQueue: Queue<ClassifyContextJob>,
    @InjectQueue(ACOUSTIC_EVENT_QUEUE)
    private readonly acousticQueue: Queue<DetectAcousticEventsJob>,
    @InjectQueue(RISK_AGGREGATION_QUEUE)
    private readonly riskQueue: Queue<AggregateRiskJob>,
    private readonly storage: ObjectStorageService,
    config: ConfigService,
  ) {
    this.maxAudioSizeBytes = config.getOrThrow<number>('MAX_AUDIO_SIZE_BYTES');
  }

  async create(
    tenantId: string,
    input: CreateAnalysisDto,
  ): Promise<CreateAnalysisResponse> {
    this.assertTenantId(tenantId);
    if (input.sizeBytes > this.maxAudioSizeBytes) {
      throw new PayloadTooLargeException(
        `Audio exceeds the ${this.maxAudioSizeBytes} byte upload limit`,
      );
    }

    const analysisId = new Types.ObjectId();
    const objectKey = `${tenantId}/${analysisId.toHexString()}/source`;
    const uploadMode = input.uploadMode ?? AudioUploadMode.Single;
    const multipartPartCount =
      uploadMode === AudioUploadMode.Multipart
        ? Math.ceil(input.sizeBytes / MULTIPART_PART_SIZE_BYTES)
        : undefined;
    if (
      multipartPartCount !== undefined &&
      multipartPartCount > MAX_MULTIPART_PARTS
    ) {
      throw new PayloadTooLargeException(
        'Audio requires too many multipart upload chunks',
      );
    }
    const document = await this.analysisModel.create({
      _id: analysisId,
      tenantId,
      childId: input.childId,
      sourceObjectKey: objectKey,
      originalFileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      uploadMode,
      multipartPartCount,
      multipartPartSizeBytes:
        uploadMode === AudioUploadMode.Multipart
          ? MULTIPART_PART_SIZE_BYTES
          : undefined,
      transcriptionLanguageMode:
        input.transcriptionLanguageMode ?? TranscriptionLanguageMode.Auto,
      status: AnalysisStatus.AwaitingUpload,
      progress: 0,
    });

    try {
      if (uploadMode === AudioUploadMode.Multipart) {
        const multipartUploadId = await this.storage.createMultipartUpload(
          objectKey,
          input.contentType,
        );
        document.multipartUploadId = multipartUploadId;
        await document.save();
        this.logger.log(
          `analysis.multipart_created analysisId=${analysisId.toString()} sizeBytes=${input.sizeBytes} partCount=${multipartPartCount}`,
        );
        return {
          ...this.toResponse(document),
          multipart: {
            partCount: multipartPartCount!,
            partSizeBytes: MULTIPART_PART_SIZE_BYTES,
          },
        };
      }
      const upload = await this.storage.createUploadUrl(objectKey, input.contentType);
      this.logger.log(
        `analysis.created analysisId=${analysisId.toString()} sizeBytes=${input.sizeBytes} contentType=${input.contentType}`,
      );
      return {
        ...this.toResponse(document),
        upload,
      };
    } catch (error) {
      await this.analysisModel.deleteOne({ _id: analysisId }).exec();
      this.logger.error(
        `analysis.create_failed analysisId=${analysisId.toString()}`,
      );
      throw error;
    }
  }

  async createMultipartPartUrls(
    tenantId: string,
    analysisId: string,
    input: CreateMultipartPartsDto,
  ): Promise<MultipartPartsResponse> {
    const document = await this.findMultipartDocument(tenantId, analysisId);
    const partCount = document.multipartPartCount!;
    const partNumbers = [...new Set(input.partNumbers)].sort(
      (left, right) => left - right,
    );
    if (partNumbers.some((partNumber) => partNumber > partCount)) {
      throw new BadRequestException('Multipart part number is out of range');
    }
    return {
      parts: await Promise.all(
        partNumbers.map((partNumber) =>
          this.storage.createMultipartPartUrl(
            document.sourceObjectKey,
            document.multipartUploadId!,
            partNumber,
          ),
        ),
      ),
    };
  }

  async getMultipartStatus(
    tenantId: string,
    analysisId: string,
  ): Promise<MultipartUploadStatusResponse> {
    const document = await this.findMultipartDocument(tenantId, analysisId);
    const completedParts = await this.storage.listMultipartParts(
      document.sourceObjectKey,
      document.multipartUploadId!,
    );
    return {
      sizeBytes: document.sizeBytes,
      partSizeBytes: document.multipartPartSizeBytes!,
      partCount: document.multipartPartCount!,
      completedParts,
      completedBytes: completedParts.reduce(
        (total, part) => total + part.sizeBytes,
        0,
      ),
    };
  }

  async completeMultipartUpload(
    tenantId: string,
    analysisId: string,
  ): Promise<AnalysisResponse> {
    const document = await this.findMultipartDocument(tenantId, analysisId);
    const parts = await this.storage.listMultipartParts(
      document.sourceObjectKey,
      document.multipartUploadId!,
    );
    const expectedCount = document.multipartPartCount!;
    const expectedNumbers = Array.from(
      { length: expectedCount },
      (_, index) => index + 1,
    );
    if (
      parts.length !== expectedCount ||
      parts.some(
        (part, index) => part.partNumber !== expectedNumbers[index],
      ) ||
      parts.reduce((total, part) => total + part.sizeBytes, 0) !==
        document.sizeBytes
    ) {
      throw new ConflictException(
        'Multipart upload is incomplete or has an invalid size',
      );
    }
    await this.storage.completeMultipartUpload(
      document.sourceObjectKey,
      document.multipartUploadId!,
      parts,
    );
    document.multipartUploadId = undefined;
    await document.save();
    this.logger.log(
      `analysis.multipart_completed analysisId=${analysisId} parts=${parts.length} sizeBytes=${document.sizeBytes}`,
    );
    return this.completeUpload(tenantId, analysisId);
  }

  async abortMultipartUpload(
    tenantId: string,
    analysisId: string,
  ): Promise<AnalysisResponse> {
    const document = await this.findMultipartDocument(tenantId, analysisId);
    await this.storage.abortMultipartUpload(
      document.sourceObjectKey,
      document.multipartUploadId!,
    );
    document.multipartUploadId = undefined;
    document.status = AnalysisStatus.Failed;
    document.failureReason = 'Multipart upload cancelled';
    await document.save();
    return this.toResponse(document);
  }

  async completeUpload(
    tenantId: string,
    analysisId: string,
  ): Promise<AnalysisResponse> {
    const document = await this.findDocument(tenantId, analysisId);
    if (
      document.status !== AnalysisStatus.AwaitingUpload &&
      document.status !== AnalysisStatus.Queueing
    ) {
      return this.toResponse(document);
    }

    const queueJobId = `ingest-${analysisId}`;
    if (document.status === AnalysisStatus.AwaitingUpload) {
      await this.storage.assertObject(
        document.sourceObjectKey,
        document.sizeBytes,
      );
      this.logger.log(
        `analysis.upload_verified analysisId=${analysisId} sizeBytes=${document.sizeBytes}`,
      );
      document.status = AnalysisStatus.Queueing;
      document.queueJobId = queueJobId;
      document.uploadedAt = new Date();
      await document.save();
    }

    await this.ingestQueue.add(
      AUDIO_INGEST_JOB,
      {
        analysisId,
        tenantId,
        objectKey: document.sourceObjectKey,
        contentType: document.contentType,
        sizeBytes: document.sizeBytes,
      },
      {
        jobId: queueJobId,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5_000,
        },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    this.logger.log(
      `analysis.ingest_dispatched analysisId=${analysisId} queueJobId=${queueJobId}`,
    );

    const queued = await this.analysisModel
      .findOneAndUpdate(
        {
          _id: document._id,
          tenantId,
          status: AnalysisStatus.Queueing,
        },
        {
          $set: {
            status: AnalysisStatus.Queued,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();

    return this.toResponse(queued ?? (await this.findDocument(tenantId, analysisId)));
  }

  async getById(
    tenantId: string,
    analysisId: string,
  ): Promise<AnalysisResponse> {
    return this.toResponse(await this.findDocument(tenantId, analysisId));
  }

  async getPlayback(
    tenantId: string,
    analysisId: string,
  ): Promise<AudioPlaybackResponse> {
    const document = await this.findDocument(tenantId, analysisId);
    const playback = await this.storage.createPlaybackUrl(
      document.sourceObjectKey,
    );
    return {
      ...playback,
      contentType: document.contentType,
      fileName: document.originalFileName,
    };
  }

  async list(
    tenantId: string,
    query: ListAnalysesDto,
  ): Promise<AnalysisPageResponse> {
    this.assertTenantId(tenantId);
    const filter = { tenantId };
    const [documents, total] = await Promise.all([
      this.analysisModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.analysisModel.countDocuments(filter).exec(),
    ]);
    return {
      items: documents.map((document) => this.toResponse(document)),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  async startDiarization(
    tenantId: string,
    analysisId: string,
    input: StartDiarizationDto,
  ): Promise<AnalysisResponse> {
    const document = await this.findDocument(tenantId, analysisId);
    if (
      document.transcriptionStage.status !== PipelineStageStatus.Completed
    ) {
      throw new BadRequestException(
        'Transcription must complete before diarization',
      );
    }
    if (
      document.diarizationStage?.status === PipelineStageStatus.Running ||
      document.diarizationStage?.status === PipelineStageStatus.Queued
    ) {
      return this.toResponse(document);
    }
    if (
      document.diarizationStage?.status === PipelineStageStatus.Completed &&
      !input.force
    ) {
      return this.toResponse(document);
    }
    await this.analysisModel
      .updateOne(
        { _id: document._id, tenantId },
        {
          $set: {
            status: AnalysisStatus.Processing,
            progress: 75,
            diarizationStage: {
              status: PipelineStageStatus.Queued,
              progress: 0,
              attempts: document.diarizationStage?.attempts ?? 0,
              updatedAt: new Date(),
            },
            conversationStage: {
              status: PipelineStageStatus.Pending,
              progress: 0,
              attempts: document.conversationStage?.attempts ?? 0,
            },
          },
          ...(input.force
            ? {
                $unset: {
                  diarizationSummary: 1,
                  conversationSummary: 1,
                },
              }
            : {}),
        },
      )
      .exec();
    const queueJobId = input.force
      ? `diarize-${analysisId}-${Date.now()}`
      : `diarize-${analysisId}`;
    await this.diarizationQueue.add(
      SPEECH_DIARIZATION_JOB,
      {
        analysisId,
        tenantId,
        objectKey: document.sourceObjectKey,
      },
      {
        jobId: queueJobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 15_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    this.logger.log(
      `diarization.dispatched analysisId=${analysisId} force=${input.force} queueJobId=${queueJobId}`,
    );
    return this.toResponse(await this.findDocument(tenantId, analysisId));
  }

  async startContextClassification(
    tenantId: string,
    analysisId: string,
    input: StartContextClassificationDto,
  ): Promise<AnalysisResponse> {
    const document = await this.findDocument(tenantId, analysisId);
    if (
      document.conversationStage.status !== PipelineStageStatus.Completed
    ) {
      throw new BadRequestException(
        'Conversation building must complete before context classification',
      );
    }
    if (
      document.contextStage?.status === PipelineStageStatus.Running ||
      document.contextStage?.status === PipelineStageStatus.Queued
    ) {
      return this.toResponse(document);
    }
    if (
      document.contextStage?.status === PipelineStageStatus.Completed &&
      !input.force
    ) {
      return this.toResponse(document);
    }
    await this.analysisModel
      .updateOne(
        { _id: document._id, tenantId },
        {
          $set: {
            status: AnalysisStatus.Processing,
            progress: 90,
            contextStage: {
              status: PipelineStageStatus.Queued,
              progress: 0,
              attempts: document.contextStage?.attempts ?? 0,
              updatedAt: new Date(),
            },
            riskStage: {
              status: PipelineStageStatus.Pending,
              progress: 0,
              attempts: document.riskStage?.attempts ?? 0,
            },
          },
          $unset: {
            riskSummary: 1,
            ...(input.force ? { contextSummary: 1 } : {}),
          },
        },
      )
      .exec();
    await this.riskIncidentModel
      .deleteMany({ analysisJobId: document._id, tenantId })
      .exec();
    const queueJobId = input.force
      ? `context-${analysisId}-${Date.now()}`
      : `context-${analysisId}`;
    await this.contextQueue.add(
      CONTEXT_CLASSIFICATION_JOB,
      { analysisId, tenantId },
      {
        jobId: queueJobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    this.logger.log(
      `context.dispatched analysisId=${analysisId} force=${input.force} queueJobId=${queueJobId}`,
    );
    return this.toResponse(await this.findDocument(tenantId, analysisId));
  }

  async startAcousticDetection(
    tenantId: string,
    analysisId: string,
    input: StartAcousticDetectionDto,
  ): Promise<AnalysisResponse> {
    const document = await this.findDocument(tenantId, analysisId);
    if (
      document.transcriptionStage.status !== PipelineStageStatus.Completed
    ) {
      throw new BadRequestException(
        'Transcription must complete before acoustic-event detection',
      );
    }
    if (
      document.acousticStage?.status === PipelineStageStatus.Running ||
      document.acousticStage?.status === PipelineStageStatus.Queued
    ) {
      return this.toResponse(document);
    }
    if (
      document.acousticStage?.status === PipelineStageStatus.Completed &&
      !input.force
    ) {
      return this.toResponse(document);
    }
    await this.analysisModel
      .updateOne(
        { _id: document._id, tenantId },
        {
          $set: {
            status: AnalysisStatus.Processing,
            progress: 95,
            acousticStage: {
              status: PipelineStageStatus.Queued,
              progress: 0,
              attempts: document.acousticStage?.attempts ?? 0,
              updatedAt: new Date(),
            },
            riskStage: {
              status: PipelineStageStatus.Pending,
              progress: 0,
              attempts: document.riskStage?.attempts ?? 0,
            },
          },
          $unset: {
            riskSummary: 1,
            ...(input.force ? { acousticSummary: 1 } : {}),
          },
        },
      )
      .exec();
    await this.riskIncidentModel
      .deleteMany({ analysisJobId: document._id, tenantId })
      .exec();
    const queueJobId = input.force
      ? `acoustic-${analysisId}-${Date.now()}`
      : `acoustic-${analysisId}`;
    await this.acousticQueue.add(
      ACOUSTIC_EVENT_JOB,
      {
        analysisId,
        tenantId,
        objectKey: document.sourceObjectKey,
      },
      {
        jobId: queueJobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    this.logger.log(
      `acoustic.dispatched analysisId=${analysisId} force=${input.force} queueJobId=${queueJobId}`,
    );
    return this.toResponse(await this.findDocument(tenantId, analysisId));
  }

  async startRiskAggregation(
    tenantId: string,
    analysisId: string,
    input: StartRiskAggregationDto,
  ): Promise<AnalysisResponse> {
    const document = await this.findDocument(tenantId, analysisId);
    if (
      document.contextStage.status !== PipelineStageStatus.Completed ||
      document.acousticStage.status !== PipelineStageStatus.Completed
    ) {
      throw new BadRequestException(
        'Context and acoustic analysis must complete before risk aggregation',
      );
    }
    if (
      document.riskStage?.status === PipelineStageStatus.Running ||
      document.riskStage?.status === PipelineStageStatus.Queued
    ) {
      return this.toResponse(document);
    }
    if (
      document.riskStage?.status === PipelineStageStatus.Completed &&
      !input.force
    ) {
      return this.toResponse(document);
    }
    await this.analysisModel
      .updateOne(
        { _id: document._id, tenantId },
        {
          $set: {
            status: AnalysisStatus.Processing,
            progress: 98,
            riskStage: {
              status: PipelineStageStatus.Queued,
              progress: 0,
              attempts: document.riskStage?.attempts ?? 0,
              updatedAt: new Date(),
            },
          },
          ...(input.force ? { $unset: { riskSummary: 1 } } : {}),
        },
      )
      .exec();
    const queueJobId = input.force
      ? `risk-${analysisId}-${Date.now()}`
      : `risk-${analysisId}`;
    await this.riskQueue.add(
      RISK_AGGREGATION_JOB,
      { analysisId, tenantId },
      {
        jobId: queueJobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    this.logger.log(
      `risk.dispatched analysisId=${analysisId} force=${input.force} queueJobId=${queueJobId}`,
    );
    return this.toResponse(await this.findDocument(tenantId, analysisId));
  }

  async listSegments(
    tenantId: string,
    analysisId: string,
    query: ListSegmentsDto,
  ): Promise<SegmentPageResponse> {
    await this.findDocument(tenantId, analysisId);
    const filter = {
      analysisJobId: new Types.ObjectId(analysisId),
      tenantId,
      ...(query.type ? { segmentType: query.type } : {}),
    };
    const [documents, total] = await Promise.all([
      this.segmentModel
        .find(filter)
        .sort({ startMs: 1, endMs: 1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.segmentModel.countDocuments(filter).exec(),
    ]);

    return {
      items: documents.map((document) => this.toSegmentResponse(document)),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  async listTranscriptions(
    tenantId: string,
    analysisId: string,
    query: ListTranscriptionsDto,
  ): Promise<TranscriptionPageResponse> {
    await this.findDocument(tenantId, analysisId);
    const filter = {
      analysisJobId: new Types.ObjectId(analysisId),
      tenantId,
    };
    const [documents, total] = await Promise.all([
      this.transcriptionModel
        .find(filter)
        .sort({ chunkIndex: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.transcriptionModel.countDocuments(filter).exec(),
    ]);
    return {
      items: documents.map((document) =>
        this.toTranscriptionResponse(document),
      ),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  async listConversations(
    tenantId: string,
    analysisId: string,
    query: ListTranscriptionsDto,
  ): Promise<ConversationPageResponse> {
    await this.findDocument(tenantId, analysisId);
    const filter = {
      analysisJobId: new Types.ObjectId(analysisId),
      tenantId,
    };
    const [documents, total] = await Promise.all([
      this.conversationModel
        .find(filter)
        .sort({ sessionIndex: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.conversationModel.countDocuments(filter).exec(),
    ]);
    return {
      items: documents.map((document) =>
        this.toConversationResponse(document),
      ),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  async listTimelineEvents(
    tenantId: string,
    analysisId: string,
    query: ListTranscriptionsDto,
  ): Promise<TimelineEventPageResponse> {
    await this.findDocument(tenantId, analysisId);
    const filter = {
      analysisJobId: new Types.ObjectId(analysisId),
      tenantId,
    };
    const [documents, total] = await Promise.all([
      this.eventModel
        .find(filter)
        .sort({ startMs: 1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.eventModel.countDocuments(filter).exec(),
    ]);
    return {
      items: documents.map((document) => this.toEventResponse(document)),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  async listAcousticEvents(
    tenantId: string,
    analysisId: string,
    query: ListTranscriptionsDto,
  ): Promise<AcousticEventPageResponse> {
    await this.findDocument(tenantId, analysisId);
    const filter = {
      analysisJobId: new Types.ObjectId(analysisId),
      tenantId,
    };
    const [documents, total] = await Promise.all([
      this.acousticEventModel
        .find(filter)
        .sort({ startMs: 1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.acousticEventModel.countDocuments(filter).exec(),
    ]);
    return {
      items: documents.map((document) =>
        this.toAcousticEventResponse(document),
      ),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  async listRiskIncidents(
    tenantId: string,
    analysisId: string,
    query: ListTranscriptionsDto,
  ): Promise<RiskIncidentPageResponse> {
    await this.findDocument(tenantId, analysisId);
    const filter = {
      analysisJobId: new Types.ObjectId(analysisId),
      tenantId,
    };
    const [documents, total] = await Promise.all([
      this.riskIncidentModel
        .find(filter)
        .sort({ startMs: 1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.riskIncidentModel.countDocuments(filter).exec(),
    ]);
    return {
      items: documents.map((document) =>
        this.toRiskIncidentResponse(document),
      ),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  private async findDocument(
    tenantId: string,
    analysisId: string,
  ): Promise<AnalysisJobDocument> {
    this.assertTenantId(tenantId);
    if (!Types.ObjectId.isValid(analysisId)) {
      throw new BadRequestException('Invalid analysis id');
    }

    const document = await this.analysisModel
      .findOne({
        _id: new Types.ObjectId(analysisId),
        tenantId,
      })
      .exec();

    if (!document) {
      throw new NotFoundException('Analysis was not found');
    }
    return document;
  }

  private assertTenantId(tenantId: string): void {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenantId)) {
      throw new BadRequestException('Invalid authenticated parent identifier');
    }
  }

  private async findMultipartDocument(
    tenantId: string,
    analysisId: string,
  ): Promise<AnalysisJobDocument> {
    const document = await this.findDocument(tenantId, analysisId);
    if (
      document.uploadMode !== AudioUploadMode.Multipart ||
      !document.multipartUploadId ||
      !document.multipartPartCount ||
      !document.multipartPartSizeBytes
    ) {
      throw new ConflictException('Analysis has no active multipart upload');
    }
    if (document.status !== AnalysisStatus.AwaitingUpload) {
      throw new ConflictException('Analysis is not awaiting an upload');
    }
    return document;
  }

  private toResponse(document: AnalysisJobDocument): AnalysisResponse {
    return {
      acousticStage: document.acousticStage ?? {
        attempts: 0,
        progress: 0,
        status: PipelineStageStatus.Pending,
      },
      acousticSummary: document.acousticSummary,
      riskStage: document.riskStage ?? {
        attempts: 0,
        progress: 0,
        status: PipelineStageStatus.Pending,
      },
      riskSummary: document.riskSummary,
      analysisId: document._id.toString(),
      childId: document.childId,
      conversationStage: document.conversationStage ?? {
        attempts: 0,
        progress: 0,
        status: PipelineStageStatus.Pending,
      },
      conversationSummary: document.conversationSummary,
      contextStage: document.contextStage ?? {
        attempts: 0,
        progress: 0,
        status: PipelineStageStatus.Pending,
      },
      contextSummary: document.contextSummary,
      contentType: document.contentType,
      createdAt: document.createdAt,
      fileName: document.originalFileName,
      diarizationStage: document.diarizationStage ?? {
        attempts: 0,
        progress: 0,
        status: PipelineStageStatus.Pending,
      },
      diarizationSummary: document.diarizationSummary,
      ingestStage: document.ingestStage,
      mediaMetadata: document.mediaMetadata,
      progress: document.progress,
      scanStage: document.scanStage,
      scanSummary: document.scanSummary,
      transcriptionStage: document.transcriptionStage,
      transcriptionLanguageMode:
        document.transcriptionLanguageMode ?? TranscriptionLanguageMode.Auto,
      transcriptionSummary: document.transcriptionSummary,
      sizeBytes: document.sizeBytes,
      status: document.status,
      updatedAt: document.updatedAt,
      uploadMode: document.uploadMode ?? AudioUploadMode.Single,
    };
  }

  private toConversationResponse(
    document: ConversationSessionDocument,
  ) {
    return {
      sessionId: document._id.toString(),
      sessionIndex: document.sessionIndex,
      startMs: document.startMs,
      endMs: document.endMs,
      speakers: document.speakers,
      utterances: document.utterances,
      environment: document.environment,
      childPresent: document.childPresent,
      quality: document.quality,
      conversationType: document.conversationType,
      profanity: document.profanity,
      safetySignals: document.safetySignals ?? [],
      contextModel: document.contextModel,
    };
  }

  private toEventResponse(document: TimelineEventDocument) {
    return {
      eventId: document._id.toString(),
      startMs: document.startMs,
      endMs: document.endMs,
      eventType: document.eventType,
      severity: document.severity,
      confidence: document.confidence,
      speakerId: document.speakerId,
      evidence: document.evidence,
      childInvolvement: document.childInvolvement,
      model: document.modelName,
    };
  }

  private toAcousticEventResponse(document: AcousticEventDocument) {
    return {
      eventId: document._id.toString(),
      startMs: document.startMs,
      endMs: document.endMs,
      label: document.label,
      category: document.category,
      severity: document.severity,
      confidence: document.confidence,
      model: document.modelName,
    };
  }

  private toRiskIncidentResponse(document: RiskIncidentDocument) {
    return {
      incidentId: document._id.toString(),
      startMs: document.startMs,
      endMs: document.endMs,
      incidentType: document.incidentType,
      severity: document.severity,
      confidence: document.confidence,
      modalities: document.modalities,
      evidence: document.evidence,
      rationale: document.rationale,
      childInvolvement: document.childInvolvement,
      reviewStatus: document.reviewStatus,
    };
  }

  private toTranscriptionResponse(
    document: TranscriptionChunkDocument,
  ): TranscriptionChunkResponse {
    return {
      chunkId: document._id.toString(),
      chunkIndex: document.chunkIndex,
      startMs: document.startMs,
      endMs: document.endMs,
      durationMs: document.durationMs,
      ranges: document.ranges,
      sourceRegionCount: document.sourceRegionCount,
      status: document.status,
      text: document.text,
      language: document.language,
      languageMode: document.languageMode,
      languageProbability: document.languageProbability,
      model: document.modelName,
      processingSeconds: document.processingSeconds,
      extractionSeconds: document.extractionSeconds,
      inferenceSeconds: document.inferenceSeconds,
      audioDurationSeconds: document.audioDurationSeconds,
      audioDurationAfterVadSeconds: document.audioDurationAfterVadSeconds,
      vadFallbackUsed: document.vadFallbackUsed,
      qualityRetryUsed: document.qualityRetryUsed,
      words: document.words,
      failureReason: document.failureReason,
    };
  }

  private toSegmentResponse(document: ScanSegmentDocument): SegmentResponse {
    return {
      segmentId: document._id.toString(),
      segmentType: document.segmentType,
      sourceIntervalCount: document.sourceIntervalCount,
      startMs: document.startMs,
      endMs: document.endMs,
      speechRatio: document.speechRatio,
      rmsDbfs: document.rmsDbfs,
      peakDbfs: document.peakDbfs,
      confidence: document.confidence,
      labels: document.labels,
      needsAsr: document.needsAsr,
    };
  }
}
