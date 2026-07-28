import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum AnalysisStatus {
  AwaitingUpload = 'AWAITING_UPLOAD',
  Queueing = 'QUEUEING',
  Queued = 'QUEUED',
  Processing = 'PROCESSING',
  Completed = 'COMPLETED',
  Failed = 'FAILED',
}

export enum PipelineStageStatus {
  Pending = 'PENDING',
  Queueing = 'QUEUEING',
  Queued = 'QUEUED',
  Running = 'RUNNING',
  Completed = 'COMPLETED',
  Failed = 'FAILED',
}

export enum TranscriptionLanguageMode {
  Auto = 'AUTO',
  English = 'ENGLISH',
  HindiHinglish = 'HINDI_HINGLISH',
}

export enum AudioUploadMode {
  Multipart = 'MULTIPART',
  Single = 'SINGLE',
}

export interface AudioStreamMetadata {
  channelLayout?: string;
  channels?: number;
  codecName: string;
  index: number;
  sampleRate?: number;
}

export interface MediaMetadata {
  audioStreams: AudioStreamMetadata[];
  bitRate?: number;
  durationMs: number;
  formatName: string;
  probedAt: Date;
  sizeBytes?: number;
}

export interface PipelineStageProgress {
  attempts: number;
  progress: number;
  status: PipelineStageStatus;
  updatedAt?: Date;
}

@Schema({
  collection: 'analysis_jobs',
  timestamps: true,
  versionKey: false,
})
export class AnalysisJob {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, index: true })
  childId!: string;

  @Prop({ required: true, unique: true })
  sourceObjectKey!: string;

  @Prop({ required: true })
  originalFileName!: string;

  @Prop({ required: true })
  contentType!: string;

  @Prop({ required: true, min: 1 })
  sizeBytes!: number;

  @Prop({
    default: AudioUploadMode.Single,
    enum: AudioUploadMode,
    required: true,
  })
  uploadMode!: AudioUploadMode;

  @Prop()
  multipartUploadId?: string;

  @Prop({ min: 5 * 1024 * 1024 })
  multipartPartSizeBytes?: number;

  @Prop({ min: 1, max: 10_000 })
  multipartPartCount?: number;

  @Prop({
    required: true,
    enum: TranscriptionLanguageMode,
    default: TranscriptionLanguageMode.Auto,
  })
  transcriptionLanguageMode!: TranscriptionLanguageMode;

  @Prop({
    required: true,
    enum: AnalysisStatus,
    default: AnalysisStatus.AwaitingUpload,
    index: true,
  })
  status!: AnalysisStatus;

  @Prop({ required: true, default: 0, min: 0, max: 100 })
  progress!: number;

  @Prop({
    type: Object,
    required: true,
    default: () => ({
      status: PipelineStageStatus.Pending,
      progress: 0,
      attempts: 0,
    }),
  })
  ingestStage!: PipelineStageProgress;

  @Prop({
    type: Object,
    required: true,
    default: () => ({
      status: PipelineStageStatus.Pending,
      progress: 0,
      attempts: 0,
    }),
  })
  scanStage!: PipelineStageProgress;

  @Prop({
    type: Object,
    required: true,
    default: () => ({
      status: PipelineStageStatus.Pending,
      progress: 0,
      attempts: 0,
    }),
  })
  transcriptionStage!: PipelineStageProgress;

  @Prop({
    type: Object,
    required: true,
    default: () => ({
      status: PipelineStageStatus.Pending,
      progress: 0,
      attempts: 0,
    }),
  })
  diarizationStage!: PipelineStageProgress;

  @Prop({
    type: Object,
    required: true,
    default: () => ({
      status: PipelineStageStatus.Pending,
      progress: 0,
      attempts: 0,
    }),
  })
  conversationStage!: PipelineStageProgress;

  @Prop({
    type: Object,
    required: true,
    default: () => ({
      status: PipelineStageStatus.Pending,
      progress: 0,
      attempts: 0,
    }),
  })
  contextStage!: PipelineStageProgress;

  @Prop({
    type: Object,
    required: true,
    default: () => ({
      status: PipelineStageStatus.Pending,
      progress: 0,
      attempts: 0,
    }),
  })
  acousticStage!: PipelineStageProgress;

  @Prop({
    type: Object,
    required: true,
    default: () => ({
      status: PipelineStageStatus.Pending,
      progress: 0,
      attempts: 0,
    }),
  })
  riskStage!: PipelineStageProgress;

  @Prop({ type: Object })
  scanSummary?: {
    decodedDurationMs: number;
    processingRegionCount: number;
    processingSeconds: number;
    removedSilenceDurationMs: number;
    retainedDurationMs: number;
    retainedRatio: number;
    speechDurationMs: number;
    speechRatio: number;
    windowCount: number;
    speechIntervalCount: number;
    pipelineVersion: string;
  };

  @Prop({ type: Object })
  transcriptionSummary?: {
    chunkCount: number;
    completedChunkCount: number;
    failedChunkCount: number;
    transcribedDurationMs: number;
    wordCount: number;
  };

  @Prop({ type: Object })
  diarizationSummary?: {
    model: string;
    speakerCount: number;
    turnCount: number;
    processingSeconds: number;
  };

  @Prop({ type: Object })
  conversationSummary?: {
    sessionCount: number;
    utteranceCount: number;
  };

  @Prop({ type: Object })
  contextSummary?: {
    model: string;
    processingSeconds: number;
    sessionCount: number;
    usableSessionCount: number;
    flaggedSessionCount: number;
    safetySignalCount: number;
    highSeverityCount: number;
    profanitySessionCount: number;
    profanityOccurrenceCount: number;
    profanityNotificationCount: number;
  };

  @Prop({ type: Object })
  acousticSummary?: {
    model: string;
    processingSeconds: number;
    processedChunkCount: number;
    windowCount: number;
    eventCount: number;
    healthEventCount: number;
    coughEventCount: number;
    wheezeEventCount: number;
    gaspEventCount: number;
    highSeverityCount: number;
  };

  @Prop({ type: Object })
  riskSummary?: {
    model: string;
    processingSeconds: number;
    incidentCount: number;
    highSeverityCount: number;
    multimodalIncidentCount: number;
    evidenceCount: number;
  };

  @Prop({ type: Object })
  mediaMetadata?: MediaMetadata;

  @Prop()
  queueJobId?: string;

  @Prop()
  uploadedAt?: Date;

  @Prop()
  startedAt?: Date;

  @Prop()
  completedAt?: Date;

  @Prop()
  failureReason?: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AnalysisJobDocument = HydratedDocument<AnalysisJob>;
export const AnalysisJobSchema = SchemaFactory.createForClass(AnalysisJob);

AnalysisJobSchema.index({ tenantId: 1, createdAt: -1 });
