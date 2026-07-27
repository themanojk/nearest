import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { TranscriptionLanguageMode } from './analysis-job.schema';

export enum TranscriptionChunkStatus {
  Pending = 'PENDING',
  Queued = 'QUEUED',
  Running = 'RUNNING',
  Completed = 'COMPLETED',
  Failed = 'FAILED',
}

export interface TranscriptWord {
  endMs: number;
  probability?: number;
  startMs: number;
  text: string;
}

export interface TranscriptionRange {
  endMs: number;
  startMs: number;
}

@Schema({
  collection: 'transcription_chunks',
  timestamps: true,
  versionKey: false,
})
export class TranscriptionChunk {
  @Prop({ required: true, type: Types.ObjectId, index: true })
  analysisJobId!: Types.ObjectId;

  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, min: 0 })
  chunkIndex!: number;

  @Prop({ required: true, min: 0 })
  startMs!: number;

  @Prop({ required: true, min: 1 })
  endMs!: number;

  @Prop({ required: true, min: 1 })
  sourceRegionCount!: number;

  @Prop({ required: true, min: 1 })
  durationMs!: number;

  @Prop({ type: [Object], required: true })
  ranges!: TranscriptionRange[];

  @Prop({
    required: true,
    enum: TranscriptionChunkStatus,
    default: TranscriptionChunkStatus.Pending,
    index: true,
  })
  status!: TranscriptionChunkStatus;

  @Prop({ required: true, default: 0, min: 0 })
  attempts!: number;

  @Prop()
  text?: string;

  @Prop()
  language?: string;

  @Prop({ enum: TranscriptionLanguageMode })
  languageMode?: TranscriptionLanguageMode;

  @Prop({ min: 0, max: 1 })
  languageProbability?: number;

  @Prop()
  modelName?: string;

  @Prop({ min: 0 })
  processingSeconds?: number;

  @Prop({ min: 0 })
  extractionSeconds?: number;

  @Prop({ min: 0 })
  inferenceSeconds?: number;

  @Prop({ min: 0 })
  audioDurationSeconds?: number;

  @Prop({ min: 0 })
  audioDurationAfterVadSeconds?: number;

  @Prop()
  vadFallbackUsed?: boolean;

  @Prop()
  qualityRetryUsed?: boolean;

  @Prop({ type: [Object], default: [] })
  words!: TranscriptWord[];

  @Prop()
  failureReason?: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type TranscriptionChunkDocument =
  HydratedDocument<TranscriptionChunk>;
export const TranscriptionChunkSchema =
  SchemaFactory.createForClass(TranscriptionChunk);

TranscriptionChunkSchema.index(
  { analysisJobId: 1, chunkIndex: 1 },
  { unique: true },
);
TranscriptionChunkSchema.index({
  tenantId: 1,
  analysisJobId: 1,
  startMs: 1,
});
