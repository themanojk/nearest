import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export enum ScanSegmentType {
  Window = 'SCAN_WINDOW',
  Speech = 'SPEECH_INTERVAL',
  ProcessingRegion = 'PROCESSING_REGION',
}

@Schema({
  collection: 'scan_segments',
  timestamps: true,
  versionKey: false,
})
export class ScanSegment {
  @Prop({ required: true, type: Types.ObjectId, index: true })
  analysisJobId!: Types.ObjectId;

  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, enum: ScanSegmentType })
  segmentType!: ScanSegmentType;

  @Prop({ required: true, min: 0 })
  startMs!: number;

  @Prop({ required: true, min: 1 })
  endMs!: number;

  @Prop({ min: 0, max: 1 })
  speechRatio?: number;

  @Prop()
  rmsDbfs?: number;

  @Prop()
  peakDbfs?: number;

  @Prop({ min: 0, max: 1 })
  confidence?: number;

  @Prop({ type: [String], default: [] })
  labels!: string[];

  @Prop({ required: true, default: false })
  needsAsr!: boolean;

  @Prop({ min: 1 })
  sourceIntervalCount?: number;
}

export type ScanSegmentDocument = HydratedDocument<ScanSegment>;
export const ScanSegmentSchema = SchemaFactory.createForClass(ScanSegment);

ScanSegmentSchema.index(
  {
    analysisJobId: 1,
    segmentType: 1,
    startMs: 1,
    endMs: 1,
  },
  { unique: true },
);
ScanSegmentSchema.index({ tenantId: 1, analysisJobId: 1, startMs: 1 });
